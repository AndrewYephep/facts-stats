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
import json
import os
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
]

NODES_BY_ID = {n["id"]: n for n in NODES}

DATA_FILES = {
    "grades_data": "grades_data.json",
    "grades_history": "grades_history.json",
    "classroom_latest": "classroom_latest.json",
    "settings": "data/settings.json",
    "ai_insights": "data/ai_insights.json",
}

PROC_PATTERNS = {
    "scraper": "sis_login.py",
    "dashboard": "dashboard_server.py",
    "classroom_api": "api_server.py",
}

DASH_ENDPOINTS = {
    "computed": "/api/computed",
    "grades": "/api/grades",
    "insights": "/api/insights",
    "settings": "/api/settings",
}


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
        for nid, filename in PROC_PATTERNS.items():
            if filename in args and filename not in "monitor.py":
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

    # ---- low-level probes ----
    def _cf_headers(self):
        if CF_EMAILS:
            return {"cf-access-authenticated-user-email": CF_EMAILS[0]}
        return {}

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
    def build_snapshot(self):
        procs = _scan_processes()
        files = self._sample_files()
        services = self._sample_services(procs)
        endpoints = self._sample_endpoints(procs)
        scrape = self._sample_scrape(procs)
        extra = self._sample_extras()

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
        }

        snapshot = {
            "ts": time.time(),
            "processes": procs,
            "files": files,
            "nodes": nodes,
            "services": services,
            "scrape": scrape,
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

    def detect_and_push(self):
        """Compare current sample to previous and emit transition events."""
        try:
            procs = _scan_processes()
            files = {nid: _stat_file(PROJECT_DIR / rel) for nid, rel in DATA_FILES.items()}
        except Exception:
            return
        prev = self._prev
        for nid in PROC_PATTERNS:
            running = procs[nid]["running"]
            label = NODES_BY_ID.get(nid, {}).get("label", nid)
            if prev.get("procs", {}).get(nid) is not None and prev["procs"][nid] != running:
                self._push(nid, f"{label} {'started' if running else 'stopped'}")
        for nid, mtime in prev.get("files", {}).items():
            cur_mtime = files.get(nid, {}).get("mtime")
            label = NODES_BY_ID.get(nid, {}).get("label", nid)
            if mtime and cur_mtime and cur_mtime != mtime:
                size = files[nid].get("size", 0)
                self._push(nid, f"{label} updated · {size:,} bytes", "file")
        for svc, up in prev.get("health", {}).items():
            label = {"dashboard": "Dashboard API", "classroom_api": "Classroom API"}.get(svc, svc)
            if up is True:
                self._push(svc, f"{label} reachable")
            elif up is False:
                self._push(svc, f"{label} unreachable")

    def run(self):
        while True:
            try:
                self.detect_and_push()
                t0 = time.time()
                snap = self.build_snapshot()
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
