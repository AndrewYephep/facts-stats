#!/usr/bin/env python3
"""GradeTrack — System Map monitor.

A tiny, dependency-free telemetry server that powers the live system-map UI
(system_view/index.html). It samples processes, data-file freshness, service
health, and scrape activity every few seconds and exposes a small JSON API.

Run:
    python3 system_view/monitor.py [--port 8123]

It is strictly read-only: it never starts, stops, or writes to anything in the
pipeline. Only the Python standard library is used.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import threading
import time
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SELF_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SELF_DIR.parent
INDEX_PATH = SELF_DIR / "index.html"

# ---------------------------------------------------------------------------
# Graph definition (the curated architecture map of the real pipeline)
# ---------------------------------------------------------------------------

ZONES = [
    {"id": "ingest", "label": "Ingest · Scrape", "color": "#f97316"},
    {"id": "backend", "label": "Backend · API", "color": "#8b5cf6"},
    {"id": "compute", "label": "Compute", "color": "#2dd4bf"},
    {"id": "ai_notify", "label": "AI · Notify", "color": "#22c55e"},
    {"id": "frontend", "label": "Frontend", "color": "#3b82f6"},
    {"id": "data", "label": "Data Store", "color": "#f59e0b"},
    {"id": "external", "label": "External", "color": "#94a3b8"},
]

NODES = [
    # ---- Ingest ----
    {
        "id": "facts_sis", "label": "FACTS SIS", "sub": "Student Information System",
        "kind": "external", "zone": "ingest", "x": 140, "y": 120, "color": "#f97316", "icon": "globe",
        "role": "The school's SIS portal (sis.factsmgt.com) — the single source of truth for term "
                "grades, category averages, and every assignment.",
        "facts": [["URL", "https://sis.factsmgt.com"], ["District", "col-in"], ["Access", "username / password (config.py)"]],
    },
    {
        "id": "scraper", "label": "sis_login.py", "sub": "Scrape runner", "kind": "module", "zone": "ingest",
        "x": 390, "y": 120, "color": "#f97316", "icon": "spider", "file": "sis_login.py", "size": 1.1,
        "role": "Headless-Chromium scraper. Logs into FACTS SIS with human-like behavior, switches "
                "through classes and quarters, parses the gradebook HTML, and writes fresh snapshots. "
                "Runs on a schedule, from the dashboard button, or via CLI.",
        "facts": [["Browser", "chromium via nodriver"], ["Writes", "grades_data.json · grades_history.json"],
                  ["Triggered by", "dashboard POST /api/scrape · auto-scrape · CLI"],
                  ["Stealth", "human delays, mouse wander, typed entry"]],
        "endpoints": [["CLI", "--period all|q1..q4|s1|s2|year --classes <ids>"]],
    },
    # ---- Backend ----
    {
        "id": "dashboard", "label": "dashboard_server.py", "sub": "Main API · FastAPI", "kind": "module",
        "zone": "backend", "x": 880, "y": 260, "color": "#8b5cf6", "icon": "server", "file": "dashboard_server.py", "size": 1.25,
        "role": "Main FastAPI service. Authenticates (Cloudflare Access + token cookie), serves the "
                "GradeTrack frontend, exposes the computed endpoints, settings, insights and scrape "
                "control, streams scrape logs, and runs the auto-scrape scheduler thread.",
        "facts": [["Port", "12345 (uvicorn, default)"], ["Auth", "Cloudflare Access + login token"],
                  ["Serves", "gradetrack/ frontend"], ["Imports", "compute_bridge · grades_analytics · ai_insights · grades_config"]],
        "endpoints": [["GET", "/api/computed·overview·classes·assignments"], ["GET", "/api/settings · /api/insights · /api/scrape/logs"],
                      ["POST", "/api/settings · /api/scrape · /api/insights/ask"]],
    },
    {
        "id": "api_server", "label": "api_server.py", "sub": "Classroom intake · Flask", "kind": "module",
        "zone": "backend", "x": 390, "y": 780, "color": "#8b5cf6", "icon": "server", "file": "api_server.py",
        "role": "Small Flask intake that receives Google Classroom homework payloads posted by Apps "
                "Script, validates the API key, and stores the newest payload to classroom_latest.json.",
        "facts": [["Port", "8787"], ["Auth", "X-API-Key header"]],
        "endpoints": [["POST", "/classroom-update"], ["GET", "/classroom-latest · /health"]],
    },
    # ---- Compute ----
    {
        "id": "compute", "label": "compute_bridge.py", "sub": "Compute engine", "kind": "module", "zone": "compute",
        "x": 880, "y": 560, "color": "#2dd4bf", "icon": "cpu", "file": "compute_bridge.py",
        "role": "The compute engine. Normalizes raw + historical grades into the exact dashboard shape: "
                "running averages per period, weighted grades, GPA, trend detection, watchlists, and the "
                "all-assignments rollup served through /api/computed.",
        "facts": [["Feeds", "/api/computed"], ["Mirrors", "gradetrack/js/compute-server-bridge.js (Python port)"],
                  ["Key fns", "normalize_grades_data · compute_derived_data"]],
    },
    {
        "id": "analytics", "label": "grades_analytics.py", "sub": "Analytics model", "kind": "module", "zone": "compute",
        "x": 880, "y": 760, "color": "#2dd4bf", "icon": "cpu", "file": "grades_analytics.py",
        "role": "Analytics model: merges live + history data, flags classes / categories / assignments "
                "below the attention threshold (95%), and builds the watchlist and chart payloads used "
                "for email reports and the /api/grades model.",
        "facts": [["Used by", "sis_login (watchlist → email) · dashboard_server (/api/grades)"],
                  ["Flags", "red below 95% · orange watchlist lows"]],
    },
    # ---- AI · Notify ----
    {
        "id": "ai", "label": "ai_insights.py", "sub": "AI coach layer", "kind": "module", "zone": "ai_notify",
        "x": 1150, "y": 260, "color": "#22c55e", "icon": "brain", "file": "ai_insights.py", "size": 1.1,
        "role": "AI layer. Sends the current grade snapshot to Ollama Cloud with function tools "
                "(list_classes, get_class, create_insight) so the chat assistant answers from real "
                "grade facts. Also regenerates daily, change-gated insights after each scrape.",
        "facts": [["Provider", "Ollama Cloud (ollama.com/api/chat)"], ["Model", "gpt-oss:120b (configurable)"],
                  ["Tools", "list_classes · get_class · create_insight"], ["Output", "data/ai_insights.json"]],
    },
    {
        "id": "emailer", "label": "grades_emailer.py", "sub": "Email notifications", "kind": "module",
        "zone": "ai_notify", "x": 1150, "y": 600, "color": "#eab308", "icon": "mail", "file": "grades_emailer.py",
        "role": "Builds and sends grade-change, watchlist, homework, and error emails over SMTP after "
                "each scrape run. Pulls the homework section from the classroom payload.",
        "facts": [["SMTP", "smtp.gmail.com:587 (STARTTLS)"], ["Sections", "new · updated · homework · watchlist"],
                  ["Triggered by", "sis_login.py after scrape · error emails on crash"]],
    },
    {
        "id": "classroom_client", "label": "classroom_client.py", "sub": "Classroom helper", "kind": "module",
        "zone": "ai_notify", "x": 1150, "y": 760, "color": "#60a5fa", "icon": "book", "file": "classroom_client.py",
        "role": "Local helper that fetches the newest classroom payload from api_server on localhost:8787 "
                "and guards against stale data (older than 3h is skipped).",
        "facts": [["Calls", "GET localhost:8787/classroom-latest"], ["Used by", "grades_emailer (homework section)"],
                  ["Stale guard", "ignores payloads older than 3 hours"]],
    },
    # ---- Frontend ----
    {
        "id": "browser", "label": "GradeTrack UI", "sub": "gradetrack/index.html + js/app.js", "kind": "frontend",
        "zone": "frontend", "x": 1150, "y": 120, "color": "#3b82f6", "icon": "screen", "file": "gradetrack/index.html",
        "role": "The GradeTrack single-page app. Renders overview, reports, calendar, planner, goals, AI "
                "chat, and settings; polls the computed endpoints and streams live scrape logs.",
        "facts": [["Views", "overview · reports · calendar · planner · goals · insights · settings"],
                  ["Fetches", "/api/computed·overview·classes·assignments · /api/insights · /api/settings · /api/scrape/logs"],
                  ["Posts", "/api/scrape · /api/settings · /api/insights/ask"]],
    },
    # ---- Data ----
    {
        "id": "grades_data", "label": "grades_data.json", "sub": "Live grade snapshot", "kind": "data", "zone": "data",
        "x": 610, "y": 120, "color": "#f59e0b", "icon": "file", "file": "grades_data.json",
        "role": "Live snapshot of the current-term gradebook, written by the scraper and read by the "
                "compute layer each time the dashboard builds the computed payload.",
        "facts": [["Written by", "sis_login.py"], ["Consumed by", "dashboard_server (compute pipeline)"]],
    },
    {
        "id": "grades_history", "label": "grades_history.json", "sub": "Quarter archive", "kind": "data", "zone": "data",
        "x": 610, "y": 290, "color": "#f59e0b", "icon": "file", "file": "grades_history.json",
        "role": "Archived quarter-by-quarter grade history (Q1–Q3) merged with the live snapshot so "
                "running averages and trends span the whole academic year.",
        "facts": [["Written by", "sis_login.py (Q1–Q3 archives)"], ["Consumed by", "compute_bridge · grades_analytics"]],
    },
    {
        "id": "settings", "label": "settings.json", "sub": "data/settings.json", "kind": "data", "zone": "data",
        "x": 610, "y": 460, "color": "#f59e0b", "icon": "gear", "file": "data/settings.json",
        "role": "Dashboard settings: goal, per-class goals, excluded classes, API keys, theme, refresh "
                "interval, and the auto-scrape schedule.",
        "facts": [["Written by", "dashboard /api/settings"], ["Read by", "grades_config.load_settings()"]],
    },
    {
        "id": "ai_insights", "label": "ai_insights.json", "sub": "data/ai_insights.json", "kind": "data", "zone": "data",
        "x": 1150, "y": 440, "color": "#f59e0b", "icon": "file", "file": "data/ai_insights.json",
        "role": "Persisted AI + manual insights shown on the Insights view; regenerated only when the "
                "underlying grades actually change.",
        "facts": [["Written by", "ai_insights.py"], ["Read by", "dashboard /api/insights"]],
    },
    {
        "id": "classroom_latest", "label": "classroom_latest.json", "sub": "Homework payload", "kind": "data", "zone": "data",
        "x": 610, "y": 780, "color": "#f59e0b", "icon": "file", "file": "classroom_latest.json",
        "role": "Most recent Google Classroom homework payload (run label, generated_at, per-class "
                "assignments), read back by the emailer for the homework section.",
        "facts": [["Written by", "api_server.py"], ["Read by", "classroom_client.py"]],
    },
    # ---- External ----
    {
        "id": "ollama", "label": "Ollama Cloud", "sub": "AI provider", "kind": "external", "zone": "external",
        "x": 1460, "y": 260, "color": "#94a3b8", "icon": "cloud",
        "role": "Ollama Cloud chat API — powers the AI coach and the daily insight generation.",
        "facts": [["Endpoint", "https://ollama.com/api/chat"], ["Auth", "Bearer key from settings"]],
    },
    {
        "id": "appscript", "label": "Apps Script", "sub": "Google Classroom sync", "kind": "external", "zone": "external",
        "x": 140, "y": 780, "color": "#94a3b8", "icon": "cloud",
        "role": "Google Apps Script (google_appscript.js) that posts Google Classroom homework from "
                "Google's side into the local intake API.",
        "facts": [["Posts", "POST /classroom-update with X-API-Key"]],
    },
    {
        "id": "smtp", "label": "SMTP", "sub": "smtp.gmail.com:587", "kind": "external", "zone": "external",
        "x": 1460, "y": 600, "color": "#94a3b8", "icon": "cloud",
        "role": "Gmail SMTP relay used for grade-change reports and operational error emails.",
        "facts": [["Host", "smtp.gmail.com"], ["TLS", "STARTTLS on port 587"]],
    },
    # ---- Newer Academic OS parts ----
    {
        "id": "trilium", "label": "Trilium", "sub": "ETAPI knowledge base", "kind": "external", "zone": "external",
        "x": 140, "y": 460, "color": "#94a3b8", "icon": "book",
        "role": "Trilium personal knowledge base (ETAPI). Class folders hold the chapter notes that "
                "power note-quiz generation and Blooket quiz CSV building.",
        "facts": [["API", "ETAPI (url + token)"], ["Used by", "note-quiz scheduler · blooket_builder"],
                  ["Mapping", "class id → note folder in settings.trilium"]],
    },
    {
        "id": "scheduler", "label": "note_quiz_scheduler.py", "sub": "Per-class quiz timers", "kind": "module",
        "zone": "backend", "x": 390, "y": 460, "color": "#8b5cf6", "icon": "clock", "file": "note_quiz_scheduler.py",
        "role": "One-shot per-class scheduler. Each enabled class gets a timer that fires at its "
                "endTime on the configured weekdays, diffs the linked chapter for new lines, and "
                "generates a note quiz when enough material has been added.",
        "facts": [["Lives in", "dashboard_server process (thread)"], ["Runs", "timer per enabled class"],
                  ["Rebuild", "at startup + whenever /api/settings changes"]],
        "endpoints": [["GET", "/api/note_quiz/scheduler/status"]],
    },
    {
        "id": "note_quiz_db", "label": "note_quiz.db", "sub": "Quiz + attempt store", "kind": "data", "zone": "data",
        "x": 610, "y": 700, "color": "#f59e0b", "icon": "file", "file": "data/note_quiz.db",
        "role": "SQLite store for generated note-quiz sets, questions, attempts, and per-line colored "
                "state used by the Review-mode learning loop.",
        "facts": [["Written by", "scheduler · /api/note_quiz/sets/generate · attempts"], ["Read by", "dashboard /api/note_quiz/*"]],
    },
    {
        "id": "blooket", "label": "blooket_builder.py", "sub": "Quiz job runner", "kind": "module",
        "zone": "backend", "x": 880, "y": 400, "color": "#8b5cf6", "icon": "layers", "file": "blooket_builder.py", "size": 1.1,
        "role": "Runs the Blooket quiz pipeline: resolves the class-linked note, picks the latest "
                "chapter, asks Ollama Cloud for multiple-choice questions in Blooket's CSV template, "
                "persists the set locally, then launches the publish bot to upload it.",
        "facts": [["Driven by", "dashboard POST /api/blooket/generate · custom · cancel"],
                  ["Queue", "jobs wait behind a single worker"], ["Writes", "data/blooket_sets.json"],
                  ["Phase", "idle · generating · publishing · done · failed"]],
        "endpoints": [["GET", "/api/blooket/status"], ["POST", "/api/blooket/generate · custom · cancel"]],
    },
    {
        "id": "blooket_sets", "label": "blooket_sets.json", "sub": "Saved quiz sets", "kind": "data", "zone": "data",
        "x": 610, "y": 600, "color": "#f59e0b", "icon": "file", "file": "data/blooket_sets.json",
        "role": "Per-class registry of generated Blooket sets (setUrl, sourceNoteId, questions, "
                "publish state). Written the moment questions are generated, so a bot failure "
                "never loses the content.",
        "facts": [["Written by", "blooket_builder.py"], ["Read by", "dashboard /api/blooket/*"]],
    },
    {
        "id": "blooket_bot", "label": "Blooket publisher", "sub": "blooket-bot · Chromium", "kind": "external", "zone": "external",
        "x": 1460, "y": 440, "color": "#94a3b8", "icon": "cloud",
        "role": "Headless (VNC) Chromium bot that signs into blooket.com, opens the create page, "
                "uploads the generated CSV, and captures the new set's ID and URL.",
        "facts": [["Runs", "blooket-bot/test.py with DISPLAY over VNC"], ["Writes back", "setUrl + setID to blooket_builder"]],
    },
    {
        "id": "auth", "label": "auth.json", "sub": "Login credentials", "kind": "data", "zone": "data",
        "x": 250, "y": 460, "color": "#f59e0b", "icon": "gear", "file": "data/auth.json",
        "role": "Dashboard login credentials (username + bcrypt hash). Guarded by Cloudflare Access; "
                "recorded here so credential changes show up in the activity feed.",
        "facts": [["Written by", "set_auth.sh (bcrypt)"], ["Read by", "dashboard /login"],
                  ["Access", "Cloudflare Access + token cookie"]],
    },
]

EDGES = [
    # FACTS <-> scraper (browser session)
    {"id": "e01", "from": "facts_sis", "to": "scraper", "label": "login + gradebook session", "kind": "browser",
     "note": "Headless Chromium (nodriver) opens the family portal and gradebook."},
    {"id": "e02", "from": "scraper", "to": "facts_sis", "label": "scrape gradebooks", "kind": "browser",
     "note": "Switches classes + quarters, reads gradebook HTML."},
    # scraper writes
    {"id": "e03", "from": "scraper", "to": "grades_data", "label": "write snapshot", "kind": "write", "chain": 0,
     "note": "Term grades, categories, assignments → grades_data.json"},
    {"id": "e04", "from": "scraper", "to": "grades_history", "label": "archive Q1–Q3", "kind": "write", "chain": 0,
     "note": "Non-current quarters appended to grades_history.json"},
    {"id": "e05", "from": "scraper", "to": "analytics", "label": "build watchlist", "kind": "function", "chain": 0,
     "note": "build_dashboard_model → watchlist for the email report"},
    {"id": "e06", "from": "scraper", "to": "emailer", "label": "send grade email", "kind": "function", "chain": 0,
     "note": "New/updated grade diff + homework + watchlist email"},
    {"id": "e07", "from": "scraper", "to": "ai", "label": "regenerate insights", "kind": "function", "chain": 0,
     "note": "get_or_generate when grades changed"},
    # data -> dashboard
    {"id": "e08", "from": "grades_data", "to": "dashboard", "label": "read snapshot", "kind": "read", "chain": 1,
     "note": "_read_json(GRADES_JSON_PATH) on every computed request"},
    {"id": "e09", "from": "grades_history", "to": "dashboard", "label": "read history", "kind": "read", "chain": 1,
     "note": "History merged so running averages span the year"},
    {"id": "e10", "from": "settings", "to": "dashboard", "label": "load settings", "kind": "read",
     "note": "grades_config.load_settings() → goal, tracked classes, keys"},
    {"id": "e11", "from": "settings", "to": "ai", "label": "api key · goals", "kind": "read",
     "note": "Ollama key + per-class goals"},
    {"id": "e12", "from": "settings", "to": "scraper", "label": "excludes · schedule", "kind": "read",
     "note": "should_skip_class + autoScrape config"},
    # compute pipeline
    {"id": "e13", "from": "dashboard", "to": "compute", "label": "normalize + derive", "kind": "function", "chain": 2,
     "note": "normalize_grades_data → compute_derived_data"},
    {"id": "e14", "from": "compute", "to": "dashboard", "label": "computed payload", "kind": "function", "chain": 3,
     "note": "Derived data served by /api/computed (cached by mtime)"},
    {"id": "e15", "from": "analytics", "to": "dashboard", "label": "/api/grades model", "kind": "function",
     "note": "build_dashboard_model + build_payload for the legacy endpoint"},
    # dashboard -> scraper (subprocess)
    {"id": "e16", "from": "dashboard", "to": "scraper", "label": "launch scrape", "kind": "subprocess", "chain": 0,
     "note": "Popen sis_login.py --period … --classes … · logs streamed to /api/scrape/logs"},
    # dashboard <-> browser
    {"id": "e17", "from": "dashboard", "to": "browser", "label": "serve UI · /api/computed", "kind": "http", "chain": 4,
     "note": "HTML/JS + computed JSON endpoints"},
    {"id": "e18", "from": "browser", "to": "dashboard", "label": "POST actions", "kind": "http", "chain": 4,
     "note": "/api/scrape · /api/settings · /api/insights/ask"},
    # ai
    {"id": "e19", "from": "dashboard", "to": "ai", "label": "chat + insights", "kind": "function",
     "note": "ask_question · get_saved_insights · delete insight"},
    {"id": "e20", "from": "ai", "to": "ollama", "label": "chat · generate", "kind": "https", "chain": 0,
     "note": "POST https://ollama.com/api/chat with tool functions"},
    {"id": "e21", "from": "ai", "to": "ai_insights", "label": "save insights", "kind": "write",
     "note": "Writes generated + manual insights to data/ai_insights.json"},
    {"id": "e22", "from": "ai_insights", "to": "dashboard", "label": "serve insights", "kind": "read",
     "note": "/api/insights returns saved + manual insights"},
    # classroom chain
    {"id": "e23", "from": "appscript", "to": "api_server", "label": "POST /classroom-update", "kind": "https",
     "note": "Google Classroom homework pushed with X-API-Key"},
    {"id": "e24", "from": "api_server", "to": "classroom_latest", "label": "store payload", "kind": "write",
     "note": "Payload stamped with received_at"},
    {"id": "e25", "from": "classroom_latest", "to": "classroom_client", "label": "GET /classroom-latest", "kind": "http",
     "note": "localhost:8787 fetch for the emailer"},
    {"id": "e26", "from": "classroom_client", "to": "emailer", "label": "homework section", "kind": "function",
     "note": "Rendered into the email; stale payloads skipped"},
    # email
    {"id": "e27", "from": "emailer", "to": "smtp", "label": "send email", "kind": "smtp",
     "note": "SMTP_SSL / STARTTLS depending on config"},
    # ---- scheduler (note-quiz timers) ----
    {"id": "e28", "from": "settings", "to": "scheduler", "label": "endTimes · enable", "kind": "read",
     "note": "noteQuiz.classes schedule reloaded on every rebuild()"},
    {"id": "e29", "from": "trilium", "to": "scheduler", "label": "fetch chapter", "kind": "function",
     "note": "latest_chapter + get_note_content over ETAPI at fire time"},
    {"id": "e30", "from": "scheduler", "to": "note_quiz_db", "label": "save generated set", "kind": "write", "chain": 5,
     "note": "note_quiz.save_set when a timer fires with enough new lines"},
    {"id": "e31", "from": "scheduler", "to": "ai", "label": "generate questions", "kind": "function",
     "note": "note_quiz.generate_questions → Ollama Cloud"},
    # ---- blooket pipeline ----
    {"id": "e32", "from": "dashboard", "to": "blooket", "label": "start / cancel job", "kind": "function",
     "note": "POST /api/blooket/generate · /api/blooket/custom · cancel"},
    {"id": "e33", "from": "settings", "to": "blooket", "label": "ollama key · notes", "kind": "read",
     "note": "Ollama key + trilium notes map"},
    {"id": "e34", "from": "trilium", "to": "blooket", "label": "chapter content", "kind": "read",
     "note": "resolve class note → latest chapter for question generation"},
    {"id": "e35", "from": "blooket", "to": "ollama", "label": "generate CSV", "kind": "https", "chain": 6,
     "note": "Ollama Cloud multiple-choice questions in Blooket CSV template"},
    {"id": "e36", "from": "blooket", "to": "blooket_sets", "label": "save set", "kind": "write",
     "note": "Persisted the moment questions are generated (before publish)"},
    {"id": "e37", "from": "blooket", "to": "blooket_bot", "label": "launch publisher", "kind": "subprocess",
     "note": "blooket-bot/test.py · Chromium session uploads CSV"},
    {"id": "e38", "from": "blooket_bot", "to": "blooket_sets", "label": "publish result", "kind": "write",
     "note": "setUrl + setID written back after the bot captures them"},
    {"id": "e39", "from": "blooket", "to": "browser", "label": "job status · result", "kind": "http",
     "note": "frontend polls /api/blooket/status and streams live job logs"},
]

NODES_BY_ID = {n["id"]: n for n in NODES}

DATA_FILES = {
    "grades_data": "grades_data.json",
    "grades_history": "grades_history.json",
    "classroom_latest": "classroom_latest.json",
    "settings": "data/settings.json",
    "ai_insights": "data/ai_insights.json",
    "blooket_sets": "data/blooket_sets.json",
    "note_quiz_db": "data/note_quiz.db",
    "auth": "data/auth.json",
}

# Which watched files are JSON enough to fingerprint key-by-key.
# (note_quiz.db is SQLite — it is hashed whole instead.)
JSON_FILES = {k for k, v in DATA_FILES.items() if v.endswith(".json")}

ORIGIN_HINTS = {
    "grades_data": "sis_login.py · scrape wrote snapshot",
    "grades_history": "sis_login.py · scrape archived quarters",
    "classroom_latest": "api_server.py ← Apps Script",
    "settings": "browser · POST /api/settings",
    "auth": "set_auth.sh · CLI credential change",
}

PROC_PATTERNS = {
    "scraper": "sis_login.py",
    "dashboard": ("dashboard_server.py", "dashboard_server", "uvicorn"),
    "classroom_api": "api_server.py",
}

DASH_ENDPOINTS = {
    "computed": "/api/computed",
    "grades": "/api/grades",
    "insights": "/api/insights",
    "settings": "/api/settings",
}

# Each real dashboard endpoint → the exact edges that genuinely carry data when
# that request is served (data reads into the dashboard + the serving edge back
# to the browser). Drives real, precise edge flow from pushed activity.
ACTIVITY_EDGES = [
    # (substring, [edges that carry the read/serve])
    ("/api/computed/assignments", ["e08", "e09", "e13", "e14", "e17"]),
    ("/api/computed/overview",    ["e08", "e09", "e13", "e14", "e17"]),
    ("/api/computed/classes",     ["e08", "e09", "e13", "e14", "e17"]),
    ("/api/computed",             ["e08", "e09", "e13", "e14", "e17"]),
    ("/api/grades",               ["e08", "e09", "e15", "e17"]),
    ("/api/settings",             ["e10", "e17"]),
    ("/api/insights",             ["e22", "e17"]),
    ("/api/todos",                ["e10", "e17"]),
    ("/api/scrape",               ["e16", "e17"]),
    ("/api/blooket/classes",      ["e33", "e17"]),
    ("/api/blooket/set",          ["e17"]),
    ("/api/blooket/quiz",         ["e17"]),
    ("/api/trilium",              ["e33", "e17"]),
    ("/api/note_quiz",            ["e17"]),
    ("/api/auth",                 ["e17"]),
]

# Endpoints we never treat as real activity (monitor/health/static plumbing).
ACTIVITY_SKIP = ("/health", "/login", "/logout", "/favicon.ico", "/static/", "/js/", "/css/", "/logo.png", "/api/activity")

EDGES_BY_ID = {e["id"]: e for e in EDGES}

def _activity_edges_for(path):
    """Return the precise edge ids that carry data for a real request path."""
    if any(path.startswith(s) for s in ACTIVITY_SKIP):
        return []
    for frag, edges in ACTIVITY_EDGES:
        if frag in path:
            return edges
    return ["e17"] if path != "/" else ["e17"]


def build_graph():
    return {
        "name": "GradeTrack",
        "subtitle": "Live pipeline map",
        "width": 1700,
        "height": 1000,
        "zones": ZONES,
        "nodes": NODES,
        "edges": EDGES,
    }


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _env_from_file():
    env = {}
    path = PROJECT_DIR / ".env"
    if not path.is_file():
        return env
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.lower().startswith("export "):
                line = line[7:].strip()
            key, sep, value = line.partition("=")
            if sep:
                env[key.strip()] = value.strip().strip('"').strip("'")
    except Exception:
        pass
    return env


ENV = _env_from_file()
ENV.update({k: v for k, v in os.environ.items() if k and not k.startswith("_")})

CF_EMAILS = [
    e.strip().lower()
    for e in ENV.get("CF_ACCESS_EMAILS", ENV.get("CF_ACCESS_EMAIL", "")).split(",")
    if e.strip()
]


def _probe(url, headers=None, timeout=1.2):
    try:
        req = Request(url, headers=headers or {})
        with urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return False
            try:
                return json.loads(resp.read().decode("utf-8"))
            except Exception:
                return True
    except (HTTPError, URLError, TimeoutError, OSError):
        return None


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def _stat_file(path):
    try:
        st = os.stat(path)
        return {
            "exists": True,
            "path": str(path),
            "size": st.st_size,
            "mtime": st.st_mtime,
            "age": max(0.0, time.time() - st.st_mtime),
        }
    except OSError:
        return {"exists": False, "path": str(path), "size": 0, "mtime": 0, "age": None}


def _etime_to_seconds(raw):
    raw = (raw or "").strip()
    if not raw:
        return None
    days = 0
    if "-" in raw:
        day_part, raw = raw.split("-", 1)
        try:
            days = int(day_part)
        except ValueError:
            return None
    parts = raw.split(":")
    try:
        if len(parts) == 3:
            h, m, s = parts
        elif len(parts) == 2:
            h, m, s = 0, parts[0], parts[1]
        else:
            return None
        return days * 86400 + int(h) * 3600 + int(m) * 60 + float(s)
    except ValueError:
        return None


def _scan_processes():
    """Return {node_id: {...}} for known pipeline modules."""
    found = {nid: {"running": False, "pid": None, "cpu": 0.0, "mem": 0.0,
                   "uptime": None, "args": ""} for nid in PROC_PATTERNS}
    try:
        proc = subprocess.run(
            ["ps", "-axo", "pid=,pcpu=,pmem=,etime=,args="],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return found
    for line in proc.stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        try:
            pid, cpu, mem, etime = parts[0], parts[1], parts[2], parts[3]
        except (IndexError, ValueError):
            continue
        args = parts[4]
        for nid, pat in PROC_PATTERNS.items():
            pats = (pat,) if isinstance(pat, str) else pat
            if any(p in args for p in pats) and "monitor.py" not in args:
                found[nid] = {
                    "running": True,
                    "pid": int(pid),
                    "cpu": float(cpu or 0),
                    "mem": float(mem or 0),
                    "uptime": _etime_to_seconds(etime),
                    "args": args.strip(),
                }
    return found


def _fmt_iso(ts):
    try:
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ""


def _fmt_iso_short(ts):
    try:
        return datetime.fromtimestamp(ts).strftime("%H:%M:%S")
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# JSON fingerprinting (action-origin detection)
# ---------------------------------------------------------------------------

def _hash_bytes(data):
    return hashlib.md5(data).hexdigest()[:12]


def _file_hash(path):
    try:
        with open(path, "rb") as handle:
            return _hash_bytes(handle.read())
    except OSError:
        return None


def _fp_walk(obj, prefix, fp, depth):
    if isinstance(obj, dict):
        if not obj:
            fp[prefix or "@"] = "{}"
            return
        for k, v in obj.items():
            p = prefix + "." + k if prefix else k
            fp[p] = _hash_bytes(json.dumps(v, sort_keys=True, default=str).encode("utf-8"))
            if isinstance(v, (dict, list)) and depth < 3:
                _fp_walk(v, p, fp, depth + 1)
    elif isinstance(obj, list):
        fp[prefix or "@"] = _hash_bytes(("len:" + str(len(obj))).encode("utf-8"))
        if depth < 3:
            for item in obj[:8]:
                _fp_walk(item, prefix + "[*]", fp, depth + 1)


def _json_fp(path):
    """Structural fingerprint of a JSON file: dotted-path -> hash of subtree."""
    data = _read_json(path)
    if data is None:
        return None
    fp = {}
    _fp_walk(data, "", fp, 0)
    return fp


def _changed_json_keys(path, old_fp):
    """Dotted paths that changed vs the previous fingerprint (capped, readable)."""
    fp = _json_fp(path)
    if fp is None:
        return ["<rewritten>"] if old_fp else []
    if old_fp is None:
        return list(fp.keys())[:10] or ["<written>"]
    changed = [k for k in fp if fp.get(k) != old_fp.get(k)]
    return changed[:10]


def _infer_origin(node_id, changed, blooket_phase, scraping):
    if node_id == "ai_insights":
        if any(k.startswith("manual") for k in changed):
            return "browser · /api/insights (manual)"
        return "ai_insights.py · post-scrape regenerate"
    if node_id == "blooket_sets":
        if blooket_phase not in ("idle", None):
            return "blooket_builder.py · active job (" + (blooket_phase or "?") + ")"
        return "blooket_builder.py · set edit / publish"
    if node_id == "note_quiz_db":
        return "note-quiz job · dashboard / scheduler (quiz play writes too)"
    if node_id in ORIGIN_HINTS:
        return ORIGIN_HINTS[node_id]
    if scraping:
        return "scrape pipeline"
    return "pipeline component"


# ---------------------------------------------------------------------------
# Telemetry engine
# ---------------------------------------------------------------------------

class Telemetry:
    def __init__(self, dash_port, api_port, poll, dash_host="127.0.0.1", api_host="127.0.0.1"):
        self.dash_port = dash_port
        self.api_port = api_port
        self.dash_host = dash_host
        self.api_host = api_host
        self.poll = poll
        self.started = time.time()
        self._lock = threading.Lock()
        self._snapshot = {"ts": time.time(), "error": "warming up"}
        self._prev = {}
        self._events = deque(maxlen=240)
        self._event_seq = 0
        self._last_scrape_logs = []
        self._ep_hits = {}
        self._ep_last = {}
        self._file_fp = {}          # node_id -> dict fingerprint (JSON) or md5 (raw)
        self._scrape_src = None     # origin label of the running / last scrape
        self._blooket_state = {"phase": None, "queued": None}
        self._nq_last_fired = {}

    # ---- low-level probes ----
    def _cf_headers(self):
        headers = {"X-Monitor-Probe": "1"}
        if CF_EMAILS:
            headers["cf-access-authenticated-user-email"] = CF_EMAILS[0]
        return headers

    def _sample_files(self):
        out = {}
        for nid, rel in DATA_FILES.items():
            out[nid] = _stat_file(PROJECT_DIR / rel)
        return out

    def _sample_services(self, processes):
        dash_up = None
        if processes.get("dashboard", {}).get("running"):
            dash_up = _probe(f"http://{self.dash_host}:{self.dash_port}/health")
        api_up = None
        if processes.get("classroom_api", {}).get("running"):
            api_up = _probe(f"http://{self.api_host}:{self.api_port}/health")
        return {"dashboard": dash_up, "classroom_api": api_up}

    def _sample_endpoints(self, processes):
        """Probe the dashboard's real data endpoints; each success counts as a live pull."""
        out = {}
        if not processes.get("dashboard", {}).get("running"):
            return out
        base = f"http://{self.dash_host}:{self.dash_port}"
        for name, path in DASH_ENDPOINTS.items():
            ok = bool(_probe(base + path, headers=self._cf_headers(), timeout=1.6))
            hits = self._ep_hits.get(name, 0)
            last = self._ep_last.get(name)
            if ok:
                hits += 1
                last = time.time()
            self._ep_hits[name] = hits
            self._ep_last[name] = last
            out[name] = {"ok": ok, "hits": hits, "lastHit": last}
        return out

    def _sample_scrape(self, processes):
        if not processes.get("dashboard", {}).get("running"):
            return None
        data = _probe(
            f"http://{self.dash_host}:{self.dash_port}/api/scrape/logs",
            headers=self._cf_headers(), timeout=1.6,
        )
        if not isinstance(data, dict):
            return {"running": False, "exitCode": None, "logs": []}
        return {
            "running": bool(data.get("running")),
            "exitCode": data.get("exitCode"),
            "logs": data.get("logs") or [],
        }

    def _scrape_origin(self, scrape):
        """Fingerprint who started the scrape from the first log line."""
        if not scrape:
            return None
        for line in scrape.get("logs") or []:
            if line.startswith("Starting "):
                m = re.search(r"Starting ([^:]+):", line)
                tag = (m.group(1) or "").strip() if m else ""
                if tag.startswith("auto"):
                    return "auto-scrape timer"
                return "manual · browser POST /api/scrape"
        return "unknown"

    def _sample_blooket(self, processes):
        """Live Blooket pipeline job + queue via /api/blooket/status."""
        if not processes.get("dashboard", {}).get("running"):
            return None
        data = _probe(
            f"http://{self.dash_host}:{self.dash_port}/api/blooket/status",
            headers=self._cf_headers(), timeout=1.6,
        )
        if not isinstance(data, dict):
            return None
        result = data.get("result") or {}
        return {
            "running": bool(data.get("running")),
            "phase": data.get("phase") or "idle",
            "status": data.get("status") or "",
            "exitCode": data.get("exitCode"),
            "jobId": data.get("jobId"),
            "queued": data.get("queued") or 0,
            "queue": data.get("queue") or [],
            "cancelRequested": bool(data.get("cancelRequested")),
            "result": {k: result.get(k) for k in ("setUrl", "questionCount", "title") if result.get(k)},
        }

    def _sample_note_quiz(self, processes):
        """Live note-quiz scheduler timers via /api/note_quiz/scheduler/status."""
        if not processes.get("dashboard", {}).get("running"):
            return None
        data = _probe(
            f"http://{self.dash_host}:{self.dash_port}/api/note_quiz/scheduler/status",
            headers=self._cf_headers(), timeout=1.6,
        )
        if not isinstance(data, dict):
            return None
        return {
            "activeTimers": data.get("activeTimers") or 0,
            "lastRebuildAt": data.get("lastRebuildAt"),
            "lastFired": data.get("lastFired") or {},
        }

    def _sample_extras(self):
        settings = _read_json(PROJECT_DIR / DATA_FILES["settings"]) or {}
        api_keys = settings.get("apiKeys") or {}
        ollama_key = api_keys.get("ollama") if isinstance(api_keys, dict) else None
        ai = _read_json(PROJECT_DIR / DATA_FILES["ai_insights"]) or {}
        insights = ai.get("insights") or []
        manual = ai.get("manualInsights") or []
        classroom = _read_json(PROJECT_DIR / DATA_FILES["classroom_latest"]) or {}
        payload_age = None
        assignments = 0
        if classroom:
            rx = classroom.get("received_at")
            if isinstance(rx, (int, float)):
                payload_age = max(0.0, time.time() - rx)
            assignments = sum(
                len(c.get("assignments") or []) for c in (classroom.get("classes") or [])
            )
        smtp_configured = bool(
            ENV.get("SMTP_HOST") and ENV.get("SMTP_TO") and ENV.get("SMTP_FROM")
        )
        auto = settings.get("autoScrape") or {}
        schedule = None
        if isinstance(auto, dict) and auto.get("enabled"):
            schedule = auto.get("times") or auto.get("scheduleTimes")
        return {
            "settings": {
                "goal": settings.get("goal"),
                "theme": settings.get("theme"),
                "autoScrapeEnabled": bool(isinstance(auto, dict) and auto.get("enabled")),
                "autoScrapeSchedule": schedule,
                "ollamaModel": settings.get("ollamaModel"),
                "updated": settings.get("updated"),
            },
            "ollama_configured": bool(ollama_key),
            "smtp_configured": smtp_configured,
            "classroom": {"payloadAge": payload_age, "assignments": assignments},
            "ai": {
                "insights": len(insights),
                "manual": len(manual),
                "status": ai.get("status"),
                "generatedAt": ai.get("generatedAt"),
                "lastAttempt": ai.get("lastAttemptDate"),
            },
        }

    # ---- snapshot ----
    def _assemble(self, procs, files, services, endpoints, scrape, extra, blooket, note_quiz):
        last_log = ""
        if scrape and scrape.get("logs"):
            for line in reversed(scrape["logs"]):
                if line.strip():
                    last_log = line.strip()
                    break

        nodes = {
            "facts_sis": {"kind": "external"},
            "scraper": {
                "running": procs["scraper"]["running"],
                "pid": procs["scraper"]["pid"],
                "cpu": procs["scraper"]["cpu"],
                "mem": procs["scraper"]["mem"],
                "uptime": procs["scraper"]["uptime"],
                "args": procs["scraper"]["args"],
                "scrapeRunning": bool(scrape and scrape["running"]),
                "scrapeOrigin": self._scrape_origin(scrape),
                "exitCode": scrape and scrape["exitCode"],
                "lastLog": last_log,
                "schedule": extra["settings"]["autoScrapeSchedule"],
            },
            "dashboard": {
                "running": procs["dashboard"]["running"],
                "pid": procs["dashboard"]["pid"],
                "cpu": procs["dashboard"]["cpu"],
                "mem": procs["dashboard"]["mem"],
                "uptime": procs["dashboard"]["uptime"],
                "health": bool(services["dashboard"]),
                "endpoints": endpoints,
                "scrape": scrape,
                "autoScrapeEnabled": extra["settings"]["autoScrapeEnabled"],
                "autoScrapeSchedule": extra["settings"]["autoScrapeSchedule"],
            },
            "api_server": {
                "running": procs["classroom_api"]["running"],
                "pid": procs["classroom_api"]["pid"],
                "cpu": procs["classroom_api"]["cpu"],
                "mem": procs["classroom_api"]["mem"],
                "uptime": procs["classroom_api"]["uptime"],
                "health": bool(services["classroom_api"]),
                "payloadAge": extra["classroom"]["payloadAge"],
                "assignments": extra["classroom"]["assignments"],
            },
            "compute": {"kind": "library", "dataAge": files["grades_data"]["age"]},
            "analytics": {"kind": "library"},
            "ai": {
                "kind": "library",
                "configured": extra["ollama_configured"],
                "insights": extra["ai"]["insights"],
                "manual": extra["ai"]["manual"],
                "status": extra["ai"]["status"],
                "generatedAt": extra["ai"]["generatedAt"],
                "lastAttempt": extra["ai"]["lastAttempt"],
            },
            "emailer": {"kind": "library", "configured": extra["smtp_configured"]},
            "classroom_client": {"kind": "library", "payloadAge": extra["classroom"]["payloadAge"]},
            "browser": {"kind": "frontend"},
            "ollama": {"kind": "external", "configured": extra["ollama_configured"]},
            "smtp": {"kind": "external", "configured": extra["smtp_configured"]},
            "appscript": {"kind": "external", "payloadAge": extra["classroom"]["payloadAge"]},
            "trilium": {"kind": "external"},
            "scheduler": {
                "kind": "library",
                "activeTimers": (note_quiz or {}).get("activeTimers") or 0,
                "lastRebuildAt": (note_quiz or {}).get("lastRebuildAt"),
                "lastFired": (note_quiz or {}).get("lastFired") or {},
            },
            "blooket": {
                "kind": "library",
                **(blooket or {}),
            },
        }

        snapshot = {
            "ts": time.time(),
            "processes": procs,
            "files": files,
            "nodes": nodes,
            "services": services,
            "scrape": scrape,
            "blooket": blooket,
            "noteQuiz": note_quiz,
            "settings": extra["settings"],
        }
        self._prev = {
            "procs": {k: v["running"] for k, v in procs.items()},
            "files": {k: v["mtime"] for k, v in files.items()},
            "health": {k: v for k, v in services.items() if v is not None},
            "scrape": (scrape or {}).get("running"),
            "exit": (scrape or {}).get("exitCode"),
        }
        self._track_scrape_logs(scrape)
        return snapshot

    def _track_scrape_logs(self, scrape):
        if not scrape:
            return
        logs = scrape.get("logs") or []
        old_len = len(self._last_scrape_logs)
        if len(logs) >= old_len:
            new = logs[old_len:]
        else:
            new = logs[-4:] if logs else []
        if new and (logs != self._last_scrape_logs):
            stamp = datetime.now().strftime("%H:%M:%S")
            for line in new:
                if line.strip():
                    self._event_seq += 1
                    self._events.append({"n": self._event_seq, "t": time.time(), "time": stamp, "node": "scraper",
                                         "kind": "log", "text": line.strip()})
        self._last_scrape_logs = logs[-30:]

    def _push(self, node, text, kind="event"):
        self._event_seq += 1
        self._events.append({"n": self._event_seq, "t": time.time(), "time": datetime.now().strftime("%H:%M:%S"),
                             "node": node, "kind": kind, "text": text})

    def ingest(self, paths):
        """Realtime activity pushed by the dashboard. Convert the real request
        paths into precise edge-flow events (the exact data-carrying edges)."""
        if not paths:
            return 0
        seen_edges = set()
        labels = []
        for p in paths:
            if not isinstance(p, str):
                continue
            edges = _activity_edges_for(p)
            if not edges:
                continue
            seen_edges.update(edges)
            label = p.split("?")[0]
            labels.append(label if label else p)
        if not seen_edges:
            return 0
        text = ", ".join(labels[:5]) + ("…" if len(labels) > 5 else "")
        self._event_seq += 1
        self._events.append({
            "n": self._event_seq, "t": time.time(),
            "time": datetime.now().strftime("%H:%M:%S"),
            "node": "browser", "kind": "flow", "text": "dashboard served: " + text,
            "edges": sorted(seen_edges),
        })
        return len(seen_edges)

    def detect_and_push(self, procs, files, scrape, blooket, note_quiz):
        """Compare this sample to the previous and emit transition / fingerprint events."""
        prev = self._prev

        # -- process start / stop --
        for nid in PROC_PATTERNS:
            running = procs[nid]["running"]
            label = NODES_BY_ID.get(nid, {}).get("label", nid)
            if prev.get("procs", {}).get(nid) is not None and prev["procs"][nid] != running:
                self._push(nid, f"{label} {'started' if running else 'stopped'}")

        # -- data-file writes + JSON fingerprints (action origin) --
        for nid in DATA_FILES:
            stat = files.get(nid, {})
            prev_mtime = prev.get("files", {}).get(nid)
            label = NODES_BY_ID.get(nid, {}).get("label", nid)
            # Prime the fingerprint on first observation — no event yet.
            if nid not in self._file_fp:
                if stat.get("mtime"):
                    if nid in JSON_FILES:
                        self._file_fp[nid] = _json_fp(PROJECT_DIR / DATA_FILES[nid])
                    else:
                        self._file_fp[nid] = _file_hash(PROJECT_DIR / DATA_FILES[nid])
                continue
            if not stat.get("mtime"):
                self._push(nid, f"{label} removed from disk", "file")
                self._file_fp.pop(nid, None)
                continue
            if prev_mtime is not None and prev_mtime == stat["mtime"]:
                continue  # unchanged this poll
            changed = []
            if nid in JSON_FILES:
                changed = _changed_json_keys(PROJECT_DIR / DATA_FILES[nid], self._file_fp[nid])
                self._file_fp[nid] = _json_fp(PROJECT_DIR / DATA_FILES[nid])
                detail = " · " + ", ".join(changed) if changed else ""
            else:
                fresh = _file_hash(PROJECT_DIR / DATA_FILES[nid])
                detail = " · content changed" if self._file_fp.get(nid) != fresh else ""
                self._file_fp[nid] = fresh
            origin = _infer_origin(
                nid, changed, (blooket or {}).get("phase"),
                bool(scrape and scrape.get("running")),
            )
            size = stat.get("size", 0)
            self._push(nid, f"{label} updated · {size:,} B{detail} · from {origin}", "file")

        # -- service health --
        for svc, up in prev.get("health", {}).items():
            label = {"dashboard": "Dashboard API", "classroom_api": "Classroom API"}.get(svc, svc)
            if up is True:
                self._push(svc, f"{label} reachable")
            elif up is False:
                self._push(svc, f"{label} unreachable")

        # -- scrape start / finish with a fingerprinted origin --
        running_now = bool(scrape and scrape.get("running"))
        running_prev = bool(prev.get("scrape"))
        if running_now and not running_prev:
            origin = self._scrape_origin(scrape) or "unknown"
            self._scrape_src = origin
            self._push("scraper", f"scrape started · origin: {origin}")
        elif running_prev and not running_now:
            exit_code = (scrape or {}).get("exitCode")
            origin = self._scrape_src or (self._scrape_origin(scrape) or "unknown")
            tag = f" · exit {exit_code}" if exit_code is not None else ""
            self._push("scraper", f"scrape finished{tag} · origin: {origin}")
            self._scrape_src = None

        # -- blooket job + queue transitions --
        phase = (blooket or {}).get("phase")
        queued = (blooket or {}).get("queued", 0) if blooket else 0
        prev_phase = self._blooket_state.get("phase")
        prev_queued = self._blooket_state.get("queued")
        if blooket and phase != prev_phase:
            if phase == "generating" and prev_phase in ("idle", None):
                self._push("blooket", f"blooket job started · generating questions" +
                           (f" · {queued} queued" if queued else ""))
            elif phase == "publishing":
                self._push("blooket", "blooket job publishing… (Chromium bot)")
            elif phase == "done":
                res = blooket.get("result") or {}
                self._push("blooket", "blooket job done · " + (res.get("setUrl") or f"{res.get('questionCount')} questions"))
            elif phase == "failed":
                self._push("blooket", "blooket job FAILED" + (f" · exit {blooket.get('exitCode')}" if blooket.get("exitCode") is not None else ""))
            elif phase == "idle" and prev_phase not in ("idle", None):
                if prev_phase != "done" and prev_phase != "failed":
                    self._push("blooket", "blooket job finished")
        elif blooket and queued != prev_queued:
            self._push("blooket", f"blooket queue → {queued} pending" + (f" · next: {blooket['queue'][0].get('label')}" if blooket.get("queue") else ""))
        self._blooket_state = {"phase": phase, "queued": queued}

        # -- note-quiz scheduler fires --
        fired = (note_quiz or {}).get("lastFired") or {}
        for class_id, iso in fired.items():
            if iso and self._nq_last_fired.get(class_id) != iso:
                self._nq_last_fired[class_id] = iso
                self._push("scheduler", f"note-quiz generated · class {class_id} · {_fmt_iso_short(datetime.fromisoformat(iso).timestamp())}")

    def run(self):
        while True:
            try:
                t0 = time.time()
                procs = _scan_processes()
                files = self._sample_files()
                services = self._sample_services(procs)
                endpoints = self._sample_endpoints(procs)
                scrape = self._sample_scrape(procs)
                blooket = self._sample_blooket(procs)
                note_quiz = self._sample_note_quiz(procs)
                extra = self._sample_extras()
                self.detect_and_push(procs, files, scrape, blooket, note_quiz)
                snap = self._assemble(procs, files, services, endpoints, scrape, extra, blooket, note_quiz)
                snap["sample_ms"] = round((time.time() - t0) * 1000, 1)
                snap["events"] = list(self._events)
                snap["meta"] = {
                    "monitorPid": os.getpid(),
                    "monitorUptime": time.time() - self.started,
                    "poll": self.poll,
                    "started": self.started,
                }
                with self._lock:
                    self._snapshot = snap
            except Exception as exc:  # never let the thread die
                with self._lock:
                    self._snapshot = {"ts": time.time(), "error": repr(exc)}
            time.sleep(self.poll)

    def snapshot(self):
        with self._lock:
            return dict(self._snapshot)


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "GradeTrackSystemMap/1.0"

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj))

    def do_GET(self):
        try:
            self._route()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            try:
                self._json({"error": repr(exc)}, 500)
            except Exception:
                pass

    def do_POST(self):
        try:
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            if path == "/ingest":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    body = json.loads(raw.decode("utf-8") or "{}")
                except ValueError:
                    self._json({"ok": False, "error": "bad json"}, 400)
                    return
                paths = body.get("paths") or []
                count = TELEMETRY.ingest(paths)
                self._json({"ok": True, "edgesFired": count})
                return
            self._json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            try:
                self._json({"error": repr(exc)}, 500)
            except Exception:
                pass

    def _route(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"

        if path == "/":
            if INDEX_PATH.is_file():
                data = INDEX_PATH.read_bytes()
                self._send(200, data, "text/html; charset=utf-8")
            else:
                self._json({"error": "index.html missing"}, 404)
            return

        if path == "/api/graph":
            self._json(build_graph())
            return

        if path == "/api/status":
            snap = TELEMETRY.snapshot()
            snap["health"] = {"dashboard": snap.get("services", {}).get("dashboard"),
                              "classroom_api": snap.get("services", {}).get("classroom_api")}
            self._json(snap)
            return

        if path == "/api/file":
            query = dict(pair.split("=", 1) for pair in self.path.split("?", 1)[1].split("&") if "=" in pair)
            node_id = query.get("node", "")
            node = NODES_BY_ID.get(node_id)
            if not node or not node.get("file"):
                self._json({"error": "no source file for this node"}, 404)
                return
            rel = node["file"]
            full = (PROJECT_DIR / rel).resolve()
            try:
                if not str(full).startswith(str(PROJECT_DIR)) or not full.is_file():
                    self._json({"error": "file not found"}, 404)
                    return
            except OSError:
                self._json({"error": "file not found"}, 404)
                return
            data = full.read_bytes()
            truncated = False
            if len(data) > 220_000:
                data = data[:220_000]
                truncated = True
            content = data.decode("utf-8", errors="replace")
            lang = {"py": "python", "js": "javascript", "json": "json",
                    "html": "html", "css": "css"}.get(full.suffix.lstrip("."), "text")
            self._json({"name": full.name, "path": rel, "lang": lang,
                        "bytes": len(data), "size": os.path.getsize(full),
                        "truncated": truncated, "content": content})
            return

        if path == "/api/env":
            self._json({
                "cfEmails": CF_EMAILS,
                "smtpConfigured": bool(ENV.get("SMTP_HOST") and ENV.get("SMTP_TO") and ENV.get("SMTP_FROM")),
            })
            return

        self._json({"error": "not found"}, 404)

    def log_message(self, fmt, *args):  # keep console quiet
        return


def main():
    parser = argparse.ArgumentParser(description="GradeTrack system map monitor")
    parser.add_argument("--port", type=int, default=8123, help="port to listen on (default 8123)")
    parser.add_argument("--dashboard-port", type=int, default=12345, help="dashboard_server port (default 12345)")
    parser.add_argument("--api-port", type=int, default=8787, help="api_server classroom intake port (default 8787)")
    parser.add_argument("--dash-host", default="127.0.0.1", help="dashboard_server host (default 127.0.0.1)")
    parser.add_argument("--api-host", default="127.0.0.1", help="api_server host (default 127.0.0.1)")
    parser.add_argument("--poll", type=float, default=3.0, help="telemetry refresh seconds (default 3)")
    parser.add_argument("--bind", default="0.0.0.0", help="bind address (default 0.0.0.0)")
    args = parser.parse_args()

    global TELEMETRY
    TELEMETRY = Telemetry(args.dashboard_port, args.api_port, args.poll, args.dash_host, args.api_host)
    threading.Thread(target=TELEMETRY.run, daemon=True).start()

    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"GradeTrack system map → http://{args.bind}:{args.port}")
    print(f"  dashboard probe : http://{args.dash_host}:{args.dashboard_port}/health")
    print(f"  classroom probe : http://127.0.0.1:{args.api_port}/health")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


TELEMETRY = None


if __name__ == "__main__":
    main()
