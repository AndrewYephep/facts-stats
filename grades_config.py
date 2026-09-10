"""Shared grades settings loaded from config.py with sensible defaults."""

import json
import os

SETTINGS_PATH = os.path.join(os.path.dirname(__file__), "data", "settings.json")

try:
    from config import (
        SKIP_CLASS_IDS,
        SKIP_CLASS_NAME_PATTERNS,
        SCRAPE_TERMS,
        CURRENT_TERM,
        ACADEMIC_YEAR,
        ATTENTION_PERCENT_THRESHOLD,
        WATCHLIST_BOTTOM_CATEGORIES,
        GRADES_JSON_PATH,
        GRADES_HISTORY_PATH,
        GRADES_DASHBOARD_PATH,
    )
except ImportError:
    SKIP_CLASS_IDS = []
    SKIP_CLASS_NAME_PATTERNS = [
        "Study Hall",
        "Homeroom",
        "Chapel",
        "Lunch",
        "Merit",
        "Demerit",
        "POWER Group",
    ]
    SCRAPE_TERMS = [4]
    CURRENT_TERM = 4
    ACADEMIC_YEAR = "2025-26"
    ATTENTION_PERCENT_THRESHOLD = 85
    WATCHLIST_BOTTOM_CATEGORIES = 3
    GRADES_JSON_PATH = "/home/ahepworth/facts-stats/grades_data.json"
    GRADES_HISTORY_PATH = "/home/ahepworth/facts-stats/grades_history.json"
    GRADES_DASHBOARD_PATH = "/home/ahepworth/facts-stats/grades_dashboard.html"

SKIP_CLASS_IDS = {str(x) for x in SKIP_CLASS_IDS}
SCRAPE_TERMS = [int(t) for t in SCRAPE_TERMS]
CURRENT_TERM = int(CURRENT_TERM)


def load_settings():
    defaults = {
        "goal": 90,
        "perClassGoals": {},
        "excludedClassIds": [],
        "apiKeys": {},
        "ollamaModel": "gpt-oss:120b",
        "theme": "dark",
        "trilium": {"url": "", "token": "", "notes": {}},
        "email": {"recipients": [], "subjectPrefix": "Grades Update"},
        "emailHtml": "",
        "notifications": {"enabled": False, "scrapeDone": True, "blooketDone": True, "noteQuizReady": True},
        "noteQuiz": {"classes": {}},
        "updated": "",
    }
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            return defaults
        for key, default in defaults.items():
            data.setdefault(key, default)
        # Nested defaults for notifications and noteQuiz.
        if not isinstance(data.get("notifications"), dict):
            data["notifications"] = dict(defaults["notifications"])
        for k, v in defaults["notifications"].items():
            data["notifications"].setdefault(k, v)
        if not isinstance(data.get("noteQuiz"), dict):
            data["noteQuiz"] = dict(defaults["noteQuiz"])
        if not isinstance(data["noteQuiz"].get("classes"), dict):
            data["noteQuiz"]["classes"] = {}
        return data
    except Exception:
        return defaults


def save_settings(data):
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
        with open(SETTINGS_PATH, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
        return True
    except Exception:
        return False


def should_skip_class(classid, class_name):
    if str(classid) in SKIP_CLASS_IDS:
        return True
    if str(classid) in {str(x) for x in (load_settings().get("excludedClassIds") or [])}:
        return True
    name = (class_name or "").lower()
    for pattern in SKIP_CLASS_NAME_PATTERNS:
        if pattern.lower() in name:
            return True
    return False
