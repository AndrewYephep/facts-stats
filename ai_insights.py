"""Daily, change-gated Ollama Cloud insight generation for GradeTrack."""

import hashlib
import json
import math
import os
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


INSIGHTS_PATH = os.path.join(os.path.dirname(__file__), "data", "ai_insights.json")
OLLAMA_CHAT_URL = "https://ollama.com/api/chat"
ALLOWED_ICONS = {"alert", "trend", "check", "star", "bell", "clock", "sparkle"}
ALLOWED_COLORS = {"green", "blue", "orange", "red", "yellow", "purple"}


def _read_saved():
    try:
        with open(INSIGHTS_PATH, encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def get_saved_insights():
    """Read-only API response; generation is triggered by the scraper."""
    saved = _read_saved()
    if not saved:
        return {"status": "waiting_for_grade_update", "insights": []}
    return {**saved, "insights": (saved.get("insights") or []) + (saved.get("manualInsights") or [])}


def _ollama_request(payload, key, timeout=180):
    request = Request(OLLAMA_CHAT_URL, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _ollama_request_message(payload, key, timeout=300):
    """Stream a chat completion and return the final assistant message dict.

    The message includes content and any tool_calls the model produced, so
    callers can rely on Ollama's built-in tool calling for structured output.
    Streaming keeps the connection alive while tokens are still arriving, so a
    slow model won't trip the read timeout just because it takes minutes to
    compose a long answer.
    """
    payload = dict(payload)
    payload["stream"] = True
    request = Request(OLLAMA_CHAT_URL, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    content = ""
    reasoning = ""
    tool_calls = None
    with urlopen(request, timeout=timeout) as response:
        for raw in response:
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = chunk.get("message") or {}
            piece = msg.get("content")
            if piece:
                content += piece
            think = msg.get("reasoning_content")
            if think:
                reasoning += think
            calls = msg.get("tool_calls")
            if calls:
                tool_calls = (tool_calls or []) + calls
            if chunk.get("done"):
                break
    message = {"role": "assistant", "content": content}
    if reasoning:
        message["reasoning_content"] = reasoning
    if tool_calls:
        message["tool_calls"] = tool_calls
    return message


def _ollama_request_stream(payload, key):
    request = Request(OLLAMA_CHAT_URL, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urlopen(request, timeout=180) as response:
        for raw in response:
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _run_tool(call, classes, by_id, roster, saved_rows):
    fn = (call.get("function") or {}).get("name")
    args = (call.get("function") or {}).get("arguments") or {}
    if isinstance(args, str):
        args = json.loads(args)
    if fn == "list_classes":
        return {"classes": roster}
    if fn == "get_class":
        class_id = str(args.get("classId") or "")
        class_name = str(args.get("className") or "").strip().lower()
        match = by_id.get(class_id)
        if match is None and class_name:
            match = next((c for c in classes if c["name"].lower() == class_name or class_name in c["name"].lower()), None)
        if match is not None:
            return match
        return {"error": "Unknown class. Use list_classes to see the available classes.", "classes": roster}
    if fn == "create_insight":
        class_id = str(args.get("classId"))
        if class_id not in by_id:
            return {"error": "Unknown class ID"}
        item = {"id": hashlib.sha256((class_id + str(datetime.now(timezone.utc).timestamp())).encode()).hexdigest()[:12], "classId": class_id, "categoryName": str(args.get("categoryName") or ""), "title": str(args.get("title"))[:120], "body": str(args.get("body"))[:500], "icon": args.get("icon") if args.get("icon") in ALLOWED_ICONS else "sparkle", "color": args.get("color") if args.get("color") in ALLOWED_COLORS else "blue", "priority": 5, "manual": True}
        saved_rows.append(item)
        return {"saved": item["id"]}
    return {"error": "Unsupported tool"}


def ask_question(computed, settings, question, conversation=None):
    return ask_question_with_history(computed, settings, question, conversation)


def ask_question_stream(computed, settings, question, conversation=None):
    return ask_question_with_history_stream(computed, settings, question, conversation)


def _build_chat(computed, settings, question, conversation):
    key = (settings.get("apiKeys") or {}).get("ollama")
    if not key:
        raise ValueError("Add an Ollama Cloud API key in Settings first.")
    classes = _class_payload(computed, settings.get("perClassGoals") or {})
    by_id = {c["id"]: c for c in classes}
    roster = [{"id": c["id"], "name": c["name"], "categories": [cat["name"] for cat in c["categories"]]} for c in classes]
    tools = [
        {"type": "function", "function": {"name": "list_classes", "description": "List every class with its id, name, and category names. Call this first to find the class id for a class the user mentions by name.", "parameters": {"type": "object", "properties": {}, "required": []}}},
        {"type": "function", "function": {"name": "get_class", "description": "Get current average and category averages for a class. Pass the class id from list_classes, or the class name directly.", "parameters": {"type": "object", "properties": {"classId": {"type": "string"}, "className": {"type": "string"}}}}},
        {"type": "function", "function": {"name": "create_insight", "description": "Save a user-requested insight after it is supported by grade data.", "parameters": {"type": "object", "properties": {"classId": {"type": "string"}, "categoryName": {"type": "string"}, "title": {"type": "string"}, "body": {"type": "string"}, "icon": {"type": "string"}, "color": {"type": "string"}}, "required": ["classId", "title", "body"]}}},
    ]
    from prompts import get_prompt as _prompts_get
    messages = [{"role": "system", "content": _prompts_get(settings, "grade_coach_chat")}]
    messages.extend(_normalize_history(conversation))
    messages.append({"role": "user", "content": question})
    return {"key": key, "classes": classes, "by_id": by_id, "roster": roster, "tools": tools, "messages": messages}


def _save_created_rows(saved_rows):
    if saved_rows:
        saved = _read_saved()
        saved["manualInsights"] = (saved.get("manualInsights") or []) + saved_rows
        _save(saved)


def ask_question_with_history(computed, settings, question, conversation=None):
    chat = _build_chat(computed, settings, question, conversation)
    key, classes, by_id, roster, tools, messages = chat["key"], chat["classes"], chat["by_id"], chat["roster"], chat["tools"], chat["messages"]
    saved_rows = []
    while True:
        reply = _ollama_request({"model": settings.get("ollamaModel") or "gpt-oss:120b", "stream": False, "messages": messages, "tools": tools, "options": {"temperature": 0.2}}, key)
        message = reply.get("message") or {}
        calls = message.get("tool_calls") or []
        if not calls:
            messages.append(message)
            result = {"answer": message.get("content") or "I couldn't produce an answer.", "created": saved_rows, "conversation": _conversation_payload(messages)}
            _save_created_rows(saved_rows)
            return result
        messages.append(message)
        for call in calls:
            messages.append({"role": "tool", "content": json.dumps(_run_tool(call, classes, by_id, roster, saved_rows))})


def ask_question_with_history_stream(computed, settings, question, conversation=None):
    chat = _build_chat(computed, settings, question, conversation)
    key, classes, by_id, roster, tools, messages = chat["key"], chat["classes"], chat["by_id"], chat["roster"], chat["tools"], chat["messages"]
    saved_rows = []
    while True:
        reply_stream = _ollama_request_stream({"model": settings.get("ollamaModel") or "gpt-oss:120b", "stream": True, "messages": messages, "tools": tools, "options": {"temperature": 0.2}}, key)
        content = ""
        tool_calls = None
        for chunk in reply_stream:
            msg = chunk.get("message") or {}
            piece = msg.get("content")
            if piece:
                content += piece
                yield {"type": "delta", "content": piece}
            calls = msg.get("tool_calls")
            if calls:
                tool_calls = (tool_calls or []) + calls
            if chunk.get("done"):
                break
        message = {"role": "assistant", "content": content}
        if tool_calls:
            message["tool_calls"] = tool_calls
            messages.append(message)
            for call in tool_calls:
                messages.append({"role": "tool", "content": json.dumps(_run_tool(call, classes, by_id, roster, saved_rows))})
            continue
        messages.append(message)
        _save_created_rows(saved_rows)
        yield {"type": "done", "conversation": _conversation_payload(messages), "created": saved_rows}
        return


def _normalize_history(conversation):
    if not isinstance(conversation, list):
        return []
    normalized = []
    for message in conversation[-40:]:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip()
        if role not in {"user", "assistant", "tool"}:
            continue
        item = {"role": role, "content": str(message.get("content") or "")}
        if role == "assistant" and isinstance(message.get("tool_calls"), list) and message.get("tool_calls"):
            item["tool_calls"] = message.get("tool_calls")
        tool_call_id = message.get("tool_call_id")
        if role == "tool" and tool_call_id:
            item["tool_call_id"] = str(tool_call_id)
        name = message.get("name")
        if name:
            item["name"] = str(name)
        normalized.append(item)
    return normalized


def _conversation_payload(messages):
    payload = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip()
        if role not in {"user", "assistant", "tool"}:
            continue
        item = {"role": role, "content": str(message.get("content") or "")}
        if role == "assistant" and isinstance(message.get("tool_calls"), list) and message.get("tool_calls"):
            item["tool_calls"] = message.get("tool_calls")
        tool_call_id = message.get("tool_call_id")
        if role == "tool" and tool_call_id:
            item["tool_call_id"] = str(tool_call_id)
        name = message.get("name")
        if name:
            item["name"] = str(name)
        payload.append(item)
    return payload


def remove_manual_insight(insight_id):
    saved = _read_saved()
    before = saved.get("manualInsights") or []
    saved["manualInsights"] = [item for item in before if item.get("id") != insight_id]
    _save(saved)
    return len(before) != len(saved["manualInsights"])


def _save(payload):
    os.makedirs(os.path.dirname(INSIGHTS_PATH), exist_ok=True)
    with open(INSIGHTS_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def _round1(value):
    return round(value, 1) if value is not None else None


def _project_category(avg, graded_count, score, count):
    """New category average after `count` future assignments scoring `score`%."""
    graded_count = int(graded_count or 0)
    if graded_count < 0:
        graded_count = 0
    denom = graded_count + count
    if denom <= 0:
        return _round1(score)
    base = (avg or 0.0) * graded_count
    return _round1((base + count * score) / denom)


def _grade_math(cls):
    """Weighted, calculator-ready facts for one class (current quarter).

    Mirrors compute_weighted_grade so the numbers match what the dashboard shows:
    overall = sum(category_avg * weight/100) / sum(weight/100).
    """
    categories = cls.get("categories") or []
    total_weight = 0.0
    weighted_sum = 0.0
    for cat in categories:
        avg = cat.get("average")
        weight = cat.get("weight") or 0.0
        if avg is not None and weight > 0:
            weighted_sum += avg * (weight / 100)
            total_weight += weight / 100
    overall = weighted_sum / total_weight if total_weight > 0 else None
    goal = cls.get("goal") or 90

    def overall_with(cat_avg, orig_avg, weight):
        return _round1((weighted_sum - orig_avg * (weight / 100) + cat_avg * (weight / 100)) / total_weight)

    out_categories = []
    for cat in categories:
        avg = cat.get("average")
        weight = cat.get("weight") or 0.0
        graded_count = cat.get("gradedCount") or 0
        if avg is None or weight <= 0 or total_weight <= 0:
            continue
        impact_per_point = (weight / 100) / total_weight
        cat_after_two = _project_category(avg, graded_count, 100.0, 2)
        cat_after_one = _project_category(avg, graded_count, 100.0, 1)
        gap = (goal - overall) if overall is not None else 0.0
        needed_avg = None
        if overall is not None and gap > 0 and weight > 0:
            needed_avg = _round1(overall + gap * (total_weight * 100) / weight)
        # Count of consecutive 100% scores on this category that would bring the
        # category average to needed_avg (at which point overall == goal by
        # construction). Solved from (avg*n + k*100)/(n+k) >= needed_avg.
        perfect_scores_to_goal = None
        reachable_with_perfects = False
        if needed_avg is not None and graded_count > 0:
            if needed_avg >= 100:
                perfect_scores_to_goal = None  # even all 100% can't hit goal here alone
            elif needed_avg <= avg:
                perfect_scores_to_goal = 0  # already at/past target on this category
            else:
                perfect_scores_to_goal = max(1, math.ceil(((needed_avg - avg) * graded_count) / (100 - needed_avg)))
                reachable_with_perfects = perfect_scores_to_goal < 50  # flag if it's still absurd
        out_categories.append({
            "name": cat.get("name"),
            "average": avg,
            "weight": weight,
            "gradedCount": graded_count,
            "impactPerOverallPoint": _round1(impact_per_point),
            "categoryAfterOnePerfect": cat_after_one,
            "overallAfterOnePerfect": overall_with(cat_after_one, avg, weight),
            "categoryAfterTwoPerfects": cat_after_two,
            "overallAfterTwoPerfects": overall_with(cat_after_two, avg, weight),
            "categoryAverageNeededForGoal": needed_avg,
            "perfectScoresToReachGoal": perfect_scores_to_goal,
            "reachableWithPerfects": reachable_with_perfects,
        })

    return {
        "overall": _round1(overall),
        "goal": goal,
        "gap": _round1((goal - overall) if overall is not None else None),
        "categories": out_categories,
    }


def _class_payload(computed, per_class_goals=None):
    current_term = int((computed.get("meta") or {}).get("currentTerm") or computed.get("currentTerm") or 4)
    current_period = f"q{current_term}"
    current_label = f"Quarter {current_term}"
    classes = []
    for cls in computed.get("activeClasses") or []:
        if not cls.get("isAcademic"):
            continue
        categories = []
        for category in ((cls.get("periodCategoryGrades") or {}).get(current_period) or []):
            assignments = [a for a in category.get("assignments") or [] if a.get("pct") is not None]
            categories.append({
                "name": category.get("name"),
                "average": category.get("average"),
                "weight": category.get("weight"),
                "gradedCount": len(assignments),
                "recentScores": [a.get("pct") for a in assignments[-5:]],
                "recentAssignments": [{
                    "name": a.get("name"),
                    "pct": a.get("pct"),
                    "pts": a.get("pts"),
                    "max": a.get("max"),
                    "dueDate": a.get("dueDate"),
                    "status": a.get("status"),
                } for a in assignments[-4:]],
            })
        classes.append({
            "id": str(cls.get("id")), "name": cls.get("shortName") or cls.get("name"),
            "period": current_period,
            "periodLabel": current_label,
            "overallAverage": (cls.get("periodGrade") or {}).get(current_period),
            "goal": (per_class_goals or {}).get(str(cls.get("id")), computed.get("goal", 90)),
            "categories": categories,
        })
    for cls in classes:
        cls["gradeMath"] = _grade_math(cls)
    return classes


def _fingerprint(classes):
    # The daily gate intentionally tracks scraped grade facts only, not UI/settings changes.
    source_classes = [{k: v for k, v in cls.items() if k != "goal"} for cls in classes]
    source = json.dumps({"classes": source_classes}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _extract_json(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        if text.endswith("```"):
            text = text[:-3]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("The model did not return a JSON object")
    return json.loads(text[start:end + 1])


def _validate(payload, class_ids):
    rows = payload.get("insights") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("Missing insights list")
    safe = []
    for item in rows[:24]:
        if not isinstance(item, dict) or str(item.get("classId")) not in class_ids:
            continue
        title, body = str(item.get("title", "")).strip(), str(item.get("body", "")).strip()
        if not title or not body:
            continue
        safe.append({
            "classId": str(item["classId"]), "categoryName": str(item.get("categoryName") or ""),
            "icon": item.get("icon") if item.get("icon") in ALLOWED_ICONS else "sparkle",
            "color": item.get("color") if item.get("color") in ALLOWED_COLORS else "blue",
            "title": title[:120], "body": body[:500],
            "priority": max(1, min(10, int(item.get("priority", 5)))),
            "nextGradeTarget": str(item.get("nextGradeTarget") or ""),
            "estimatedAssignments": str(item.get("estimatedAssignments") or ""),
        })
    return safe


def get_or_generate(computed, settings):
    """Return saved insights; generate at most once per UTC day and only on changed data."""
    classes, goal = _class_payload(computed, settings.get("perClassGoals") or {}), computed.get("goal", 90)
    fingerprint = _fingerprint(classes)
    saved = _read_saved()
    today = datetime.now(timezone.utc).date().isoformat()
    if saved.get("sourceFingerprint") == fingerprint:
        return {**saved, "status": "current"}
    if saved.get("lastAttemptDate") == today:
        return {**saved, "status": "waiting_for_next_daily_run"}

    key = (settings.get("apiKeys") or {}).get("ollama")
    if not key:
        return {**saved, "status": "not_configured", "message": "Add an Ollama Cloud API key in Settings to generate AI insights."}

    schema = {
        "insights": [{"classId": "string", "categoryName": "string", "icon": "alert|trend|check|star|bell|clock|sparkle", "color": "green|blue|orange|red|yellow|purple", "title": "string", "body": "string", "priority": "1-10", "nextGradeTarget": "string", "estimatedAssignments": "string"}]
    }
    prompt = (
        "You are a calculator-grade coach. Your job is to translate per-class gradeMath values into tight, "
        "specific, actionable insight text. NEVER do arithmetic — every number you write must come from the "
        "supplied gradeMath JSON verbatim (rounded only to the integer already present there).\n\n"
        "For every class below its goal, you must produce one leading recommendation in this exact shape:\n"
        "  • Pick the category that has the highest impactPerOverallPoint AND has categoryAverageNeededForGoal set.\n"
        "  • Title: '<Category> average needed'.\n"
        "  • Body (use these EXACT numbers from the data, do NOT recompute them):\n"
        "      - categoryAverageNeededForGoal (the target average that category must hit to reach the goal).\n"
        "      - perfectScoresToReachGoal (number of consecutive 100%s on that category needed to bring its\n"
        "        average up to categoryAverageNeededForGoal — already computed for you, quote the integer).\n"
        "      - current overall average (from gradeMath.overall).\n"
        "      - category's current average + the average after the projected 100%s (overallAfterTwoPerfects).\n"
        "  • Example body (do NOT round differently):\n"
        "    'You need 6 more 100%s on Homework to bring its average to 95% (currently 80%) and reach 95% overall. "
        "Right now you're at 80% overall.'\n"
        "  • End with nextGradeTarget (the needed category average, e.g. 'Target: 95% average on every remaining Homework') "
        "and estimatedAssignments (e.g. '~6 homework assignments').\n"
        "  • If perfectScoresToReachGoal is null (because neededAvg > 100), write 'Hard to reach: even all 100%s on "
        "<Category> won't get you to <goal>% overall from this category alone — focus elsewhere or shift weight'.\n"
        "  • If perfectScoresToReachGoal is 0 (the category already averages at/above neededAvg), write that the "
        "category is on track and the gap lives in another category, naming the next-highest-impact one.\n\n"
        "For every class at or above goal:\n"
        "  • Title: 'Goal met' (if within 1pt of goal) or 'Above goal' (if >1pt over).\n"
        "  • Body: one sentence naming the current overall, the goal, and the buffer. "
        "Optionally call out the thinnest-data, highest-weight category that could put it at risk.\n\n"
        "Class with no graded assignments: skip it entirely (do not emit an insight).\n\n"
        "Hard rules: at most 2 insights per class. Use concrete numbers only. Never invent. No study tips. No fluff. "
        "No 'you should', 'consider', 'try to'. State what must happen and what the result will be.\n\n"
        f"Required JSON shape: {json.dumps(schema)}\n\n"
        f"Grade data: {json.dumps({'defaultGoal': goal, 'classes': classes}, separators=(',', ':'))}"
    )
    request = Request(OLLAMA_CHAT_URL, data=json.dumps({
        "model": settings.get("ollamaModel") or "gpt-oss:120b", "stream": False,
        "messages": [{"role": "user", "content": prompt}], "options": {"temperature": 0.2},
    }).encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    base = {"lastAttemptDate": today, "sourceFingerprint": saved.get("sourceFingerprint", ""), "insights": saved.get("insights", [])}
    try:
        with urlopen(request, timeout=60) as response:
            raw = json.loads(response.read().decode("utf-8"))
        insights = _validate(_extract_json((raw.get("message") or {}).get("content")), {c["id"] for c in classes})
        result = {"generatedAt": datetime.now(timezone.utc).isoformat(), "lastAttemptDate": today, "sourceFingerprint": fingerprint, "model": settings.get("ollamaModel") or "gpt-oss:120b", "insights": insights, "status": "current"}
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        result = {**base, "status": "error", "message": f"Could not generate AI insights: {exc}"}
    _save(result)
    return result
