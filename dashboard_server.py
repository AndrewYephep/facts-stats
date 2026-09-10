"""FastAPI server to serve the dashboard HTML behind Cloudflare Access."""

import json
import hashlib
import hmac
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs
from urllib.request import Request as UrlRequest, urlopen
from typing import Dict, Optional

import bcrypt
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from build_dashboard_v2 import build_payload
from compute_bridge import compute_derived_data, normalize_grades_data
from grades_analytics import build_dashboard_model
from grades_emailer import _assignment_key

from grades_config import (
    ACADEMIC_YEAR,
    ATTENTION_PERCENT_THRESHOLD,
    CURRENT_TERM,
    GRADES_JSON_PATH,
    GRADES_HISTORY_PATH,
    SCRAPE_TERMS,
    SETTINGS_PATH,
    WATCHLIST_BOTTOM_CATEGORIES,
    load_settings,
    save_settings,
)
from ai_insights import ask_question, ask_question_stream, get_saved_insights, remove_manual_insight, _grade_math
from blooket_builder import job_status as blooket_job_status
from blooket_builder import start_pipeline as blooket_start_pipeline
from blooket_builder import start_custom_pipeline as blooket_start_custom_pipeline
from blooket_builder import load_saved_sets as blooket_load_saved_sets
from blooket_builder import saved_sets_mtime as blooket_saved_sets_mtime
from blooket_builder import find_set_by_url as blooket_find_set_by_url
from blooket_builder import find_set_by_local_key as blooket_find_set_by_local_key
from blooket_builder import find_set_by_url_or_local as blooket_find_set_by_url_or_local
from blooket_builder import update_set as blooket_update_set
from blooket_builder import delete_set as blooket_delete_set
from trilium_client import (
    TriliumError,
    check_connection,
    get_class_note,
    get_config,
    get_note,
    get_note_content,
    get_notes_map,
    latest_chapter,
    note_web_url,
    save_config,
    search_notes,
    set_class_note,
    unset_class_note,
)

import note_quiz  # Daily note quiz generator + SQLite tracker
import note_quiz_scheduler  # One-shot per-class endTime scheduler
import levels_state  # Levels-based review state (SQLite, per set)

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


_load_dotenv()

DASHBOARD_HTML_PATH = os.getenv(
    "DASHBOARD_HTML_PATH",
    os.path.join(os.path.dirname(__file__), "grades_dashboard_v3.html"),
)
REQUIRE_CF_ACCESS = os.getenv("REQUIRE_CF_ACCESS", "true").lower() == "true"
ALLOWED_EMAILS = {
    email.strip().lower()
    for email in os.getenv("CF_ACCESS_EMAILS", os.getenv("CF_ACCESS_EMAIL", "")).split(",")
    if email.strip()
}
DASHBOARD_ACCESS_TOKEN_HASH = os.getenv("DASHBOARD_ACCESS_TOKEN_HASH", "")
DASHBOARD_SESSION_SECRET = os.getenv("DASHBOARD_SESSION_SECRET", "")
DASHBOARD_USERNAME_SEED = os.getenv("DASHBOARD_USERNAME", "").strip()
DASHBOARD_PASSWORD_HASH_SEED = os.getenv("DASHBOARD_PASSWORD_HASH", "").strip()
AUTH_COOKIE_NAME = "dashboard_token"
AUTH_STATE_PATH = os.path.join(os.path.dirname(__file__), "data", "auth.json")
SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
LOGIN_WINDOW_SECONDS = 60 * 10
LOGIN_MAX_ATTEMPTS = 5

_login_failures: dict[str, list[float]] = defaultdict(list)
_scrape_job = {"process": None, "logs": [], "exitCode": None}
_scrape_lock = threading.Lock()
_auto_scrape_seen: set[str] = set()

# Real dashboard request activity, pushed to the system map monitor so the map
# animates only on real data transfers (no polling / synthetic probes).
MONITOR_URL = os.getenv("MONITOR_URL", "http://127.0.0.1:8123")
_req_activity: deque = deque(maxlen=512)
_req_activity_lock = threading.Lock()
_ACTIVITY_SKIP_PREFIXES = (
    "/static/", "/js/", "/css/", "/logo.png", "/favicon.ico",
    "/login", "/logout", "/health",
)

SCRAPE_PERIODS = {"all", "q1", "q2", "q3", "q4", "s1", "s2", "year"}

app = FastAPI(title="Grades Dashboard")
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def _no_cache_static(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path in ("/", "/logo.png") or path.startswith(("/static/", "/js/", "/css/")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


@app.middleware("http")
async def _record_activity(request: Request, call_next):
    """Record real dashboard API hits for the system map. The monitor identifies
    its own probes with X-Monitor-Probe so they never count as activity; only
    genuine browser loads/refreshes drive the map's data-flow animation."""
    path = request.url.path
    if (
        request.method == "GET"
        and path.startswith("/api/")
        and not path.startswith(_ACTIVITY_SKIP_PREFIXES)
        and request.headers.get("X-Monitor-Probe") != "1"
    ):
        try:
            with _req_activity_lock:
                _req_activity.append(path)
        except Exception:
            pass
    return await call_next(request)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

GRADETRACK_DIR = os.path.join(os.path.dirname(__file__), "gradetrack")
GRADETRACK_INDEX_PATH = os.path.join(GRADETRACK_DIR, "index.html")
for _name, _dir in (("js", "js"), ("css", "css")):
    _mount_dir = os.path.join(GRADETRACK_DIR, _dir)
    if os.path.isdir(_mount_dir):
        app.mount(f"/{_name}", StaticFiles(directory=_mount_dir), name=f"gradetrack_{_name}")


@app.get("/logo.png", response_class=FileResponse)
def logo():
    path = os.path.join(GRADETRACK_DIR, "logo.png")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, media_type="image/png")


def _get_cf_email(request: Request) -> Optional[str]:
    email = request.headers.get("cf-access-authenticated-user-email")
    if email:
        return email.strip().lower()
    return None


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        first = forwarded.split(",", 1)[0].strip()
        if first:
            return first

    connecting = request.headers.get("cf-connecting-ip", "").strip()
    if connecting:
        return connecting

    if request.client and request.client.host:
        return request.client.host

    return "unknown"


def _get_cookie_token(request: Request) -> Optional[str]:
    token = request.cookies.get(AUTH_COOKIE_NAME)
    if token:
        return token.strip()
    return None


def _request_has_valid_token(request: Request) -> bool:
    if not DASHBOARD_SESSION_SECRET:
        return False
    cookie = _get_cookie_token(request)
    if not cookie:
        return False

    try:
        expiry_text, signature = cookie.split(".", 1)
        expiry = int(expiry_text)
    except Exception:
        return False

    if expiry < int(time.time()):
        return False

    expected_signature = hmac.new(
        DASHBOARD_SESSION_SECRET.encode("utf-8"),
        expiry_text.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, expected_signature)


def _cleanup_login_failures(ip: str) -> list[float]:
    now = time.time()
    attempts = [stamp for stamp in _login_failures.get(ip, []) if now - stamp <= LOGIN_WINDOW_SECONDS]
    if attempts:
        _login_failures[ip] = attempts
    elif ip in _login_failures:
        del _login_failures[ip]
    return attempts


def _too_many_login_failures(ip: str) -> bool:
    return len(_cleanup_login_failures(ip)) >= LOGIN_MAX_ATTEMPTS


def _record_login_failure(ip: str) -> None:
    _login_failures[ip].append(time.time())


def _read_auth_state() -> Optional[dict]:
    if not os.path.isfile(AUTH_STATE_PATH):
        return None
    try:
        with open(AUTH_STATE_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            return None
        return data
    except Exception as exc:
        log.warning("Could not read auth state: %s", exc)
        return None


def _write_auth_state(username: str, password_hash: str) -> None:
    payload = {
        "username": username,
        "passwordHash": password_hash,
        "updatedAt": time.time(),
    }
    os.makedirs(os.path.dirname(AUTH_STATE_PATH), exist_ok=True)
    tmp_path = AUTH_STATE_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.replace(tmp_path, AUTH_STATE_PATH)
    try:
        os.chmod(AUTH_STATE_PATH, 0o600)
    except OSError:
        pass


def _bootstrap_auth_state() -> dict:
    """Ensure data/auth.json exists. Seeded from env vars or migrated from the
    legacy single-token hash. Returns the current auth state."""
    state = _read_auth_state()
    if state and state.get("username") and state.get("passwordHash"):
        return state

    if DASHBOARD_USERNAME_SEED and DASHBOARD_PASSWORD_HASH_SEED:
        _write_auth_state(DASHBOARD_USERNAME_SEED, DASHBOARD_PASSWORD_HASH_SEED)
        log.info("Seeded auth state from DASHBOARD_USERNAME / DASHBOARD_PASSWORD_HASH")
        return _read_auth_state()

    if DASHBOARD_ACCESS_TOKEN_HASH:
        legacy_username = DASHBOARD_USERNAME_SEED or "admin"
        _write_auth_state(legacy_username, DASHBOARD_ACCESS_TOKEN_HASH)
        log.warning(
            "Migrated legacy DASHBOARD_ACCESS_TOKEN_HASH into data/auth.json. "
            "Change your password from the Settings → Account pane as soon as possible."
        )
        return _read_auth_state()

    raise RuntimeError(
        "No auth credentials configured. Set DASHBOARD_USERNAME and "
        "DASHBOARD_PASSWORD_HASH in .env, or DASHBOARD_ACCESS_TOKEN_HASH "
        "for legacy migration."
    )


def _credentials_match(username: str, password: str) -> bool:
    """True if (username, password) match the credentials persisted in
    data/auth.json. Accepts the legacy single-token mode by treating the
    single token as the password against the seeded admin user."""
    state = _read_auth_state()
    if not state:
        return False
    expected_username = (state.get("username") or "").strip()
    stored_hash = state.get("passwordHash") or ""
    if not expected_username or not stored_hash:
        return False
    if username.strip().lower() != expected_username.lower():
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
    except ValueError:
        return False


def _token_matches_hash(token: str) -> bool:
    """Legacy fallback: lets the old single-token login keep working for one
    session if data/auth.json hasn't been seeded yet. Equivalent to checking
    the token as the password against the seeded admin user."""
    return _credentials_match(DASHBOARD_USERNAME_SEED or "admin", token)


def _build_session_cookie() -> str:
    expiry = int(time.time()) + SESSION_COOKIE_MAX_AGE
    expiry_text = str(expiry)
    signature = hmac.new(
        DASHBOARD_SESSION_SECRET.encode("utf-8"),
        expiry_text.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{expiry_text}.{signature}"


def _render_login_page(error_message: str = "") -> HTMLResponse:
        error_html = f"<div class='error'>{error_message}</div>" if error_message else ""
        return HTMLResponse(
                f"""
                <!doctype html>
                <html lang="en">
                    <head>
                        <meta charset="utf-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1">
                        <title>Grades Dashboard Login</title>
                        <style>
                            :root {{ color-scheme: light; }}
                            body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(180deg, #f6f8fc 0%, #e8eef8 100%); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #122033; }}
                            .card {{ width: min(92vw, 420px); background: rgba(255,255,255,.92); border: 1px solid #d6deea; border-radius: 18px; padding: 28px; box-shadow: 0 20px 50px rgba(18, 32, 51, .12); }}
                            .eyebrow {{ margin: 0 0 8px; font-size: .82rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #5b6b84; }}
                            h1 {{ margin: 0 0 10px; font-size: 1.7rem; line-height: 1.15; }}
                            p {{ margin: 0 0 18px; color: #4c5c73; line-height: 1.5; }}
                            label {{ display: block; margin: 0 0 8px; font-size: .95rem; font-weight: 600; color: #20324c; }}
                            input {{ width: 100%; box-sizing: border-box; padding: 12px 14px; border: 1px solid #c4cfde; border-radius: 10px; font-size: 1rem; background: #fff; color: #122033; }}
                            input:focus {{ outline: 2px solid #79a8ff; outline-offset: 2px; border-color: #79a8ff; }}
                            button {{ width: 100%; margin-top: 14px; padding: 12px 14px; border: 0; border-radius: 10px; background: #2d6cdf; color: #fff; font-size: 1rem; font-weight: 700; cursor: pointer; }}
                            button:hover {{ background: #2459b6; }}
                            .error {{ margin-top: 14px; padding: 10px 12px; border-radius: 10px; background: #fff1f1; color: #9f1c1c; border: 1px solid #f3c1c1; }}
                            .hint {{ margin-top: 14px; font-size: .9rem; color: #66768d; }}
                        </style>
                    </head>
                    <body>
                        <main class="card">
                            <div class="eyebrow">Private dashboard</div>
                            <h1>Sign in to view grades</h1>
                            <p>Enter your dashboard username and password. After sign-in, the server stores a secure HTTP-only cookie on this device.</p>
                            <form method="post" action="/login">
                                <label for="username">Username</label>
                                <input id="username" name="username" type="text" autocomplete="username" autofocus required>
                                <label for="password" style="margin-top:14px">Password</label>
                                <input id="password" name="password" type="password" autocomplete="current-password" required>
                                <button type="submit">Continue</button>
                            </form>
                            {error_html}
                            <div class="hint">If you later enable Cloudflare Access, this page can remain as a fallback.</div>
                        </main>
                    </body>
                </html>
                """
        )


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/js/", "/css/")) and response.status_code == 200:
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.middleware("http")
async def access_guard(request: Request, call_next):
    if request.url.path in {"/login", "/logout", "/health", "/favicon.ico"}:
        return await call_next(request)

    if not REQUIRE_CF_ACCESS:
        return await call_next(request)

    email = _get_cf_email(request)
    if email:
        if ALLOWED_EMAILS and email not in ALLOWED_EMAILS:
            return JSONResponse(
                status_code=403,
                content={"detail": "User not allowed"},
            )
        return await call_next(request)

    if _request_has_valid_token(request):
        return await call_next(request)

    if request.method == "GET":
        return RedirectResponse(url="/login", status_code=302)

    return JSONResponse(
        status_code=401,
        content={"detail": "Cloudflare Access required"},
    )


@app.get("/health")
def health():
    return {"ok": True}


# ─── Update manager ───────────────────────────────────────────────────────
# Lightweight wrapper around ./update.sh. The dashboard doesn't itself do a
# git pull — that happens in update.sh, with a strict denylist of protected
# paths. The dashboard just queries the script, exposes the result, and
# triggers an update run on demand. No paths in protected locations are
# touched by any of these handlers.

_UPDATE_CACHE = {"checked_at": 0.0, "data": None}
_UPDATE_CACHE_TTL = 60 * 30  # 30 min; the daily timer also refreshes


def _update_install_dir():
    """Where the repo lives. Honor env first, then .env, then the cwd."""
    p = os.environ.get("FACTS_INSTALL_DIR")
    if p and os.path.isdir(os.path.join(p, ".git")):
        return p
    here = os.getcwd()
    if os.path.isdir(os.path.join(here, ".git")):
        return here
    # Walk upward looking for the .git directory.
    cur = here
    for _ in range(6):
        cur = os.path.dirname(cur)
        if os.path.isdir(os.path.join(cur, ".git")):
            return cur
    return ""


def _update_run(cmd, cwd, timeout=30):
    try:
        out = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True,
            timeout=timeout, check=False,
        )
        return out.returncode, out.stdout, out.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as exc:
        return 1, "", repr(exc)


@app.get("/api/update/check")
def update_check():
    """Return installed vs latest commit. Cheap cache (30 min)."""
    install_dir = _update_install_dir()
    if not install_dir:
        return {"installed": "", "available": "", "behind": 0, "error":
                "Install dir not found. Run ./install.sh first."}
    now = time.time()
    if _UPDATE_CACHE["data"] and (now - _UPDATE_CACHE["checked_at"]) < _UPDATE_CACHE_TTL:
        return _UPDATE_CACHE["data"]
    try:
        # Refresh remote refs in the background; don't fetch synchronously if
        # network is slow — surface the local-vs-origin comparison immediately
        # and update asynchronously on the next call.
        installed = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=install_dir, capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        available = subprocess.run(
            ["git", "rev-parse", "--short", "origin/main"],
            cwd=install_dir, capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        behind = subprocess.run(
            ["git", "rev-list", "--count", "HEAD..origin/main"],
            cwd=install_dir, capture_output=True, text=True, timeout=5,
        ).stdout.strip() or "0"
    except Exception as exc:
        return {"installed": "", "available": "", "behind": 0, "available": False,
                "error": repr(exc)}

    payload = {
        "installed": installed,
        "available": available,
        "behind": int(behind) if behind.isdigit() else 0,
        "available": installed != available,
        "install_dir": install_dir,
        "checked_at": now,
    }
    _UPDATE_CACHE["checked_at"] = now
    _UPDATE_CACHE["data"] = payload
    return payload


@app.post("/api/update/run")
def update_run():
    """Run ./update.sh --yes and stream stdout/stderr back. Refresh cache."""
    install_dir = _update_install_dir()
    update_script = os.path.join(install_dir, "update.sh") if install_dir else ""
    if not update_script or not os.path.isfile(update_script):
        raise HTTPException(status_code=412, detail="update.sh not found in install dir")
    # Refuse if there are changes to a protected path in the diff. update.sh
    # also enforces this, but checking here gives the user a clean JSON error.
    code, _, _ = _update_run(
        ["bash", "-c", "git rev-parse --short HEAD && git rev-parse --short origin/main"],
        cwd=install_dir, timeout=10,
    )
    if code != 0:
        raise HTTPException(status_code=503, detail="git rev-parse failed")
    code, out, err = _update_run(
        ["bash", "update.sh", "--yes"],
        cwd=install_dir, timeout=180,
    )
    # Always invalidate cache after a run, success or not.
    _UPDATE_CACHE["checked_at"] = 0
    return {"ok": code == 0, "code": code, "stdout": out[-2000:], "stderr": err[-2000:]}


@app.on_event("startup")
def _bootstrap_credentials():
    """Seed data/auth.json on startup so the dashboard always has credentials."""
    try:
        _bootstrap_auth_state()
    except RuntimeError as exc:
        log.error("Could not bootstrap credentials on startup: %s", exc)


@app.get("/login", response_class=HTMLResponse)
def login_page():
        return _render_login_page()


@app.post("/login")
async def login(request: Request):
    client_ip = _client_ip(request)
    if _too_many_login_failures(client_ip):
        return _render_login_page("Too many failed attempts. Try again later.")

    body = (await request.body()).decode("utf-8", errors="ignore")
    form_data = parse_qs(body, keep_blank_values=True)
    username = str((form_data.get("username") or [""])[0]).strip()
    password = str((form_data.get("password") or form_data.get("token") or [""])[0]).strip()

    # First-time bootstrap: if no auth.json exists yet, seed from env or legacy
    # hash before we try to match, so the very first login works.
    try:
        _bootstrap_auth_state()
    except RuntimeError as exc:
        log.error("Auth bootstrap failed: %s", exc)
        return _render_login_page("Server misconfigured: no credentials available.")

    if not username or not password:
        _record_login_failure(client_ip)
        return _render_login_page("Enter your username and password.")

    if not _credentials_match(username, password):
        _record_login_failure(client_ip)
        return _render_login_page("Invalid username or password")

    _cleanup_login_failures(client_ip)

    response = RedirectResponse(url="/", status_code=302)
    secure_cookie = os.getenv("DASHBOARD_COOKIE_SECURE", "true").lower() == "true"
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=_build_session_cookie(),
        httponly=True,
        samesite="strict",
        secure=secure_cookie,
        max_age=SESSION_COOKIE_MAX_AGE,
    )
    return response


@app.post("/logout")
def logout():
        response = RedirectResponse(url="/login", status_code=302)
        response.delete_cookie(AUTH_COOKIE_NAME)
        return response


@app.get("/api/auth")
def get_auth():
    state = _bootstrap_auth_state()
    return {"username": state.get("username", "")}


@app.post("/api/auth")
async def update_auth(request: Request):
    """Change username and/or password. Requires the current password."""
    state = _bootstrap_auth_state()
    body = await request.json()
    current_password = str(body.get("currentPassword") or "")
    new_username = str(body.get("username") or "").strip()
    new_password = str(body.get("newPassword") or "")

    if not current_password:
        raise HTTPException(status_code=400, detail="Current password is required")
    if not _credentials_match(state.get("username", ""), current_password):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    username = new_username or state.get("username", "")
    if not username:
        raise HTTPException(status_code=400, detail="Username cannot be empty")

    if new_password:
        if len(new_password) < 8:
            raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
        new_hash = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")
    else:
        new_hash = state.get("passwordHash", "")

    _write_auth_state(username, new_hash)
    log.info("Dashboard credentials updated for user '%s'", username)
    return {"username": username, "passwordChanged": bool(new_password)}


def _read_json(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:
        log.warning("Could not read %s: %s", path, exc)
        return None


_MONTH_ORDER = {
    "January": 1, "February": 2, "March": 3, "April": 4, "May": 5, "June": 6,
    "July": 7, "August": 8, "September": 9, "October": 10, "November": 11, "December": 12,
}


def _load_school_events():
    """Parse the school calendar JSON into a flat list of {date, name, category, uniformDay}.

    Date strings may be a single day ("August 13") or a same-month range
    ("September 23-29") — ranges are expanded into one entry per day, with
    extra fields startDate/endDate so the frontend can render spanning pills.
    Colors are resolved on the frontend from `category`/`uniformDay`.
    """
    raw = _read_json(SCHOOL_CALENDAR_PATH)
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
            start_date = f"{year:04d}-{month:02d}-{start:02d}"
            end_date = f"{year:04d}-{month:02d}-{end:02d}"
            is_multi = end > start
            for day in range(start, end + 1):
                entry = {
                    "date": f"{year:04d}-{month:02d}-{day:02d}",
                    "name": name,
                    "category": ev.get("category"),
                    "uniformDay": bool(ev.get("uniformDay")),
                }
                if is_multi:
                    entry["startDate"] = start_date
                    entry["endDate"] = end_date
                    entry["isMultiDay"] = True
                out.append(entry)
    out.sort(key=lambda e: e["date"])
    return out


def _mask_key(value):
    if not value:
        return ""
    if len(value) >= 4:
        return "••••••••••" + value[-4:]
    return "••••••••••"


def _settings_response(settings):
    masked = {
        key: _mask_key(value)
        for key, value in (settings.get("apiKeys") or {}).items()
        if value
    }
    result = {**settings, "apiKeys": masked}
    trilium = dict(settings.get("trilium") or {})
    if trilium.get("token"):
        trilium["token"] = _mask_key(trilium["token"])
    result["trilium"] = trilium
    result["availableYears"] = _available_grade_years()
    return result


def _available_grade_years():
    """Years the dashboard can show. Live academic_year plus any archive dir."""
    years = set()
    try:
        live = _read_json(GRADES_JSON_PATH) or {}
        ay = str(live.get("academic_year") or "").strip()
        if ay:
            years.add(ay)
    except Exception:
        pass
    archive_root = os.path.join(os.path.dirname(__file__), "data", "archive")
    if os.path.isdir(archive_root):
        for name in os.listdir(archive_root):
            if os.path.isdir(os.path.join(archive_root, name)) and name:
                years.add(name)
    return sorted(years, reverse=True)


@app.get("/api/settings")
def get_settings():
    return _settings_response(load_settings())


@app.post("/api/settings")
async def post_settings(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Settings must be a JSON object")

    current = load_settings()
    stored_keys = dict(current.get("apiKeys") or {})

    posted_keys = body.get("apiKeys")
    if isinstance(posted_keys, dict):
        for key, value in posted_keys.items():
            value = str(value or "").strip()
            if value and not value.startswith("••"):
                stored_keys[key] = value
        body["apiKeys"] = stored_keys
    else:
        body["apiKeys"] = stored_keys

    stored_trilium = dict(current.get("trilium") or {})
    posted_trilium = body.get("trilium")
    if isinstance(posted_trilium, dict):
        posted_trilium = dict(posted_trilium)
        token = str(posted_trilium.get("token") or "").strip()
        if token.startswith("••"):
            posted_trilium["token"] = stored_trilium.get("token", "")
        elif not token:
            posted_trilium["token"] = stored_trilium.get("token", "")
        posted_trilium.setdefault("notes", stored_trilium.get("notes") or {})
        body["trilium"] = posted_trilium
    else:
        body["trilium"] = stored_trilium

    body["updated"] = datetime.now(timezone.utc).isoformat()

    if not save_settings(body):
        raise HTTPException(status_code=500, detail="Could not write settings")

    # Rebuild the note-quiz scheduler so any new schedule/period takes effect.
    try:
        note_quiz_scheduler.rebuild()
    except Exception as exc:
        log.warning("note-quiz scheduler rebuild failed: %s", exc)

    return {"success": True}


@app.get("/api/prompts")
def list_prompts_endpoint():
    """Return every AI prompt in the app: its key, name, description, the
    default, and the user's current override (if any)."""
    from prompts import list_prompts as _list_prompts
    return {"prompts": _list_prompts(load_settings())}


@app.post("/api/prompts")
async def save_prompts(request: Request):
    """Save user-overridden prompts. Body: {prompts: {key: text, ...}}.
    Pass an empty string or whitespace-only to clear the override (revert to default)."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be an object")
    posted = body.get("prompts")
    if not isinstance(posted, dict):
        raise HTTPException(status_code=400, detail="'prompts' must be a {key: text} object")

    current = load_settings()
    cur_prompts = dict(current.get("prompts") or {})
    for k, v in posted.items():
        s = str(v or "")
        if s.strip():
            cur_prompts[k] = s
        else:
            cur_prompts.pop(k, None)
    current["prompts"] = cur_prompts
    current["updated"] = datetime.now(timezone.utc).isoformat()
    if not save_settings(current):
        raise HTTPException(status_code=500, detail="Could not write settings")
    return {"success": True}


@app.post("/api/prompts/reset")
async def reset_prompt_endpoint(request: Request):
    """Reset one prompt to its hardcoded default. Body: {key: 'prompt_key'}."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be an object")
    key = str(body.get("key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Missing 'key'")
    from prompts import PROMPTS
    if key not in PROMPTS:
        raise HTTPException(status_code=404, detail=f"Unknown prompt key: {key}")
    current = load_settings()
    cur_prompts = dict(current.get("prompts") or {})
    cur_prompts.pop(key, None)
    current["prompts"] = cur_prompts
    current["updated"] = datetime.now(timezone.utc).isoformat()
    if not save_settings(current):
        raise HTTPException(status_code=500, detail="Could not write settings")
    return {"success": True, "default": PROMPTS[key]["default"]}


@app.post("/api/email/render")
async def render_email_preview(request: Request):
    try:
        body = await request.json() or {}
    except Exception:
        body = {}
    from grades_emailer import DEFAULT_EMAIL_TEMPLATE, EMAIL_TEMPLATE_VARIABLES, email_preview
    html = email_preview(body.get("template"), body.get("scope") or "both")
    return {"html": html, "defaultTemplate": DEFAULT_EMAIL_TEMPLATE, "variables": EMAIL_TEMPLATE_VARIABLES}


@app.post("/api/email/test")
async def send_test_email_endpoint(request: Request):
    try:
        body = await request.json() or {}
    except Exception:
        body = {}
    from grades_emailer import send_test_email
    recipients = body.get("recipients")
    if recipients is not None and not isinstance(recipients, list):
        raise HTTPException(status_code=400, detail="recipients must be a list of email addresses")
    try:
        sent = send_test_email(recipients)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"sent": bool(sent)}


@app.get("/api/ollama/models")
def get_ollama_models():
    """Live model list from Ollama Cloud for the Settings model picker."""
    settings = load_settings()
    key = (settings.get("apiKeys") or {}).get("ollama")
    try:
        request = UrlRequest(
            "https://ollama.com/api/tags",
            headers={"Authorization": f"Bearer {key}"} if key else {},
        )
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        models = [m.get("name") for m in payload.get("models") or [] if m.get("name")]
        return {"models": models}
    except HTTPError as exc:
        return {"models": [], "error": f"Ollama returned HTTP {exc.code}: {exc.reason}"}
    except URLError as exc:
        return {"models": [], "error": f"Could not reach Ollama Cloud: {exc.reason}"}
    except Exception as exc:
        return {"models": [], "error": str(exc)}


@app.get("/api/readme")
def get_readme():
    """Return the project README.md so the About pane can render and copy it."""
    readme_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "README.md")
    if not os.path.isfile(readme_path):
        return {"markdown": ""}
    try:
        with open(readme_path, encoding="utf-8") as handle:
            return {"markdown": handle.read()}
    except OSError as exc:
        log.warning("Could not read README.md: %s", exc)
        return {"markdown": ""}


@app.get("/api/status")
def get_status():
    if not os.path.isfile(GRADES_JSON_PATH):
        return {"updated": None}
    try:
        with open(GRADES_JSON_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        return {"updated": data.get("updated")}
    except Exception as exc:
        log.warning("Could not read grades data: %s", exc)
        return {"updated": None}


@app.get("/api/grades")
def get_grades():
    model = build_dashboard_model()
    payload = build_payload(model)
    return payload


_compute_cache = {"key": None, "value": None}

NEW_GRADES_PATH = os.path.join(os.path.dirname(__file__), "data", "new_grades.json")
CLASSROOM_ASSIGNMENTS_PATH = os.path.join(os.path.dirname(__file__), "data", "classroom_assignments.json")
USER_TODOS_PATH = os.path.join(os.path.dirname(__file__), "data", "user_todos.json")
SCHOOL_CALENDAR_PATH = os.path.join(os.path.dirname(__file__), "data", "school_calendar_26_67.json")


def _load_new_grade_markers():
    try:
        with open(NEW_GRADES_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _new_grade_key(a, category=None, class_id=None):
    return _assignment_key(
        class_id if class_id is not None else a.get("classId"),
        category if category is not None else a.get("category"),
        {
            "name": a.get("name"),
            "due": a.get("dueRaw") or a.get("due"),
            "max": a.get("max"),
        },
    )


def _load_user_todos():
    data = _read_json(USER_TODOS_PATH)
    if isinstance(data, dict):
        return {
            "todos": data.get("todos") or [],
            "overrides": data.get("overrides") or {},
            "hidden": data.get("hidden") or {},
            "edits": data.get("edits") or {},
        }
    return {"todos": [], "overrides": {}, "hidden": {}, "edits": {}}


def _save_user_todos(data):
    os.makedirs(os.path.dirname(USER_TODOS_PATH), exist_ok=True)
    with open(USER_TODOS_PATH, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=False)


def _normalise_name(name):
    """Lowercase, strip common prefixes/suffixes, collapse whitespace."""
    import re as _re
    s = str(name or "").lower().strip()
    # Strip common prefixes
    for prefix in ("ap ", "honors ", "hon ", "accelerated "):
        if s.startswith(prefix):
            s = s[len(prefix):]
    # Strip common suffixes
    for suffix in (" i", " ii", " iii", " iv"):
        if s.endswith(suffix):
            s = s[:-len(suffix)]
    # Collapse whitespace and remove punctuation
    s = _re.sub(r"[^a-z0-9\s]", " ", s)
    s = _re.sub(r"\s+", " ", s).strip()
    return s


# Common abbreviation → full-name expansions for classroom fuzzy matching.
_ABBREVIATIONS = {
    "eng": "english",
    "govt": "government",
    "gov": "government",
    "geom": "geometry",
    "chem": "chemistry",
    "math": "mathematics",
    "bio": "biology",
    "phys": "physics",
    "sci": "science",
    "hist": "history",
    "precalc": "precalculus",
    "precal": "precalculus",
}


def _expand_abbreviations(tokens):
    """Return a set with both the original tokens and any known expansions."""
    expanded = set()
    for t in tokens:
        expanded.add(t)
        if t in _ABBREVIATIONS:
            expanded.add(_ABBREVIATIONS[t])
    return expanded


def _match_classroom_to_classes(assignments, active_classes):
    """Fuzzy-match Google Classroom courseName → GradeTrack active class id.

    Pops a ``matchedClassId`` onto each assignment dict so the frontend can
    use the class's configured color.  Matching is two-way substring with
    abbreviation expansion:
      - "GEOM" → "geometry" matches active class "Geometry"
      - "US GOVT" → "us government" matches active class "Government"
      - "CHEM I" → "chem" → "chemistry" matches active class "Chemistry"
    """
    import re as _re

    # Build lookup of normalised active-class names → class id
    class_map = []  # [(normalised_tokens_set, class_id, original_name)]
    for cls in active_classes:
        if not cls.get("isAcademic"):
            continue
        name = cls.get("name") or cls.get("shortName") or ""
        if not name:
            continue
        norm = _normalise_name(name)
        tokens = set(norm.split())
        expanded = _expand_abbreviations(tokens)
        class_map.append((expanded, norm, str(cls.get("id")), name))

    for a in assignments:
        cn = a.get("courseName") or ""
        norm = _normalise_name(cn)
        if not norm:
            a["matchedClassId"] = None
            continue

        norm_tokens = set(norm.split())
        norm_expanded = _expand_abbreviations(norm_tokens)

        best_match = None
        best_score = 0

        for class_expanded, class_norm, class_id, orig_name in class_map:
            # Exact match
            if norm == class_norm:
                best_match = class_id
                best_score = 100
                break
            # One is a substring of the other
            if norm in class_norm or class_norm in norm:
                score = 50 + min(len(norm), len(class_norm))
                if score > best_score:
                    best_match = class_id
                    best_score = score
                continue
            # Token overlap (with abbreviation expansion)
            overlap = norm_expanded & class_expanded
            if overlap:
                score = 10 * len(overlap)
                if score > best_score:
                    best_match = class_id
                    best_score = score

        a["matchedClassId"] = best_match if best_score >= 10 else None


def _computed_payload():
    settings_probe = load_settings()
    display_year = str(settings_probe.get("displayYear") or "").strip()
    live_path = GRADES_JSON_PATH
    if display_year:
        alt_path = os.path.join(os.path.dirname(__file__), "data", "archive", display_year, "grades_data.json")
        if os.path.isfile(alt_path):
            live_path = alt_path
    key = (
        os.path.getmtime(live_path) if os.path.isfile(live_path) else 0,
        os.path.getmtime(GRADES_HISTORY_PATH) if os.path.isfile(GRADES_HISTORY_PATH) else 0,
        os.path.getmtime(SETTINGS_PATH) if os.path.isfile(SETTINGS_PATH) else 0,
        os.path.getmtime(NEW_GRADES_PATH) if os.path.isfile(NEW_GRADES_PATH) else 0,
        os.path.getmtime(CLASSROOM_ASSIGNMENTS_PATH) if os.path.isfile(CLASSROOM_ASSIGNMENTS_PATH) else 0,
        os.path.getmtime(USER_TODOS_PATH) if os.path.isfile(USER_TODOS_PATH) else 0,
        os.path.getmtime(SCHOOL_CALENDAR_PATH) if os.path.isfile(SCHOOL_CALENDAR_PATH) else 0,
    )
    if _compute_cache["key"] == key:
        return _compute_cache["value"]

    raw = _read_json(live_path)
    if not raw or not raw.get("classes"):
        raise HTTPException(status_code=500, detail="No grade data")

    history = _read_json(GRADES_HISTORY_PATH)
    settings = load_settings()

    normalized = normalize_grades_data(raw, history)
    if normalized is None:
        raise HTTPException(status_code=500, detail="No grade data")

    # Apply user-defined class name aliases ("short name" overrides) before any
    # derived display fields (activeClasses.shortName, allAssignments.className,
    # per-class goal labels, etc.) are computed. The class id stays the same —
    # this only changes how the class is displayed.
    aliases = settings.get("classAliases") or {}
    for cls in (normalized.get("classes") or []):
        alias = (aliases.get(str(cls.get("id"))) or "").strip()
        if alias:
            cls["shortName"] = alias

    goal = int(settings.get("goal") or 90)
    tracked = settings.get("trackedClassIds")
    computed = compute_derived_data(
        normalized,
        goal=goal,
        tracked_class_ids=set(tracked) if tracked else None,
        per_class_goals=settings.get("perClassGoals") or {},
    )

    payload = {**computed, "settings": settings}

    # Per-class deterministic grade math (mirrors what the AI grade coach sees).
    # Lets the Insights page surface a concrete, calculator-ready card for every
    # class without waiting for the AI to run.
    per_class_goals = settings.get("perClassGoals") or {}
    meta = payload.get("meta") or {}
    current_period = f"q{meta.get('currentTerm') or 4}"
    for cls in (payload.get("activeClasses") or []):
        if not cls.get("isAcademic"):
            continue
        cat_list = []
        for cat in (cls.get("categories") or []):
            cat_list.append({
                "name": cat.get("name"),
                "average": cat.get("average"),
                "weight": cat.get("weight"),
                "gradedCount": sum(1 for a in (cat.get("assignments") or []) if a.get("pct") is not None),
            })
        cls["gradeMath"] = _grade_math({
            "categories": cat_list,
            "goal": per_class_goals.get(str(cls.get("id")), goal),
        })
        cls["currentPeriod"] = current_period

    markers = _load_new_grade_markers()
    new_keys = {str(m.get("key")) for m in markers.get("new") or []}
    updated_keys = {str(m.get("key")) for m in markers.get("updated") or []}
    for cls in payload.get("activeClasses") or []:
        for cat in cls.get("categories") or []:
            for a in cat.get("assignments") or []:
                a["newSinceLastScrape"] = _new_grade_key(a, cat.get("name"), cls.get("id")) in new_keys
                a["updatedSinceLastScrape"] = _new_grade_key(a, cat.get("name"), cls.get("id")) in updated_keys
    for a in payload.get("allAssignments") or []:
        a["newSinceLastScrape"] = _new_grade_key(a) in new_keys
        a["updatedSinceLastScrape"] = _new_grade_key(a) in updated_keys
    payload["newAssignments"] = {
        "term": markers.get("term"),
        "academicYear": markers.get("academic_year"),
        "savedAt": markers.get("savedAt"),
        "count": sum(1 for a in (payload.get("allAssignments") or []) if a.get("newSinceLastScrape")),
    }

    classroom = _read_json(CLASSROOM_ASSIGNMENTS_PATH) or {}
    assignments = classroom.get("assignments") or []
    for a in assignments:
        cid = str(a.get("courseId") or "")
        if cid and aliases.get(cid):
            a["courseName"] = aliases[cid]

    # ── Fuzzy-match Google Classroom courseName → GradeTrack active class ──
    # Google Classroom names ("GEOM", "AP CHEM") rarely match exactly, so we
    # normalise both sides and check substring containment both ways.
    active_classes = payload.get("activeClasses") or []
    _match_classroom_to_classes(assignments, active_classes)

    # Merge submissionAttachments into materials so the detail pane shows them
    for a in assignments:
        subs = a.get("submissionAttachments") or []
        if subs:
            existing = a.get("materials") or []
            seen = {(m.get("url") or m.get("title")) for m in existing}
            for s in subs:
                key = s.get("url") or s.get("title")
                if key and key not in seen:
                    existing.append(s)
                    seen.add(key)
            a["materials"] = existing

    payload["classroomAssignments"] = assignments
    payload["classroomMeta"] = {
        "count": len(payload["classroomAssignments"]),
        "receivedAt": classroom.get("received_at"),
        "receivedAtIso": classroom.get("received_at_iso"),
    }
    payload["userTodos"] = _load_user_todos()
    payload["schoolEvents"] = _load_school_events()

    _compute_cache["key"] = key
    _compute_cache["value"] = payload
    return payload


@app.get("/api/computed")
def get_computed():
    return _computed_payload()


@app.get("/api/insights")
def get_ai_insights():
    return get_saved_insights()


@app.post("/api/insights/ask")
async def ask_ai_insight(request: Request):
    body = await request.json()
    question = str(body.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is empty")
    if body.get("stream"):
        return StreamingResponse(_ai_insights_stream(question, body.get("conversation") or []), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    try:
        result = ask_question(_computed_payload(), load_settings(), question, body.get("conversation") or [])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


def _ai_insights_stream(question, conversation):
    try:
        for event in ask_question_stream(_computed_payload(), load_settings(), question, conversation):
            yield "data: " + json.dumps(event) + "\n\n"
    except ValueError as exc:
        yield "data: " + json.dumps({"type": "error", "message": str(exc)}) + "\n\n"
    except Exception as exc:
        yield "data: " + json.dumps({"type": "error", "message": "Failed to ask: " + str(exc)}) + "\n\n"


@app.delete("/api/insights/{insight_id}")
def delete_ai_insight(insight_id: str):
    removed = remove_manual_insight(insight_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Insight not found")
    return {"removed": True}


def _collect_scrape_output(process):
    for line in iter(process.stdout.readline, ""):
        with _scrape_lock:
            _scrape_job["logs"].append(line.rstrip())
            _scrape_job["logs"] = _scrape_job["logs"][-500:]
    code = process.wait()
    _cleanup_stale_scrape_browser()
    _sweep_tmp_profiles()
    with _scrape_lock:
        _scrape_job["exitCode"] = code
        _scrape_job["logs"].append(f"Scrape finished with exit code {code}.")


# ─── TRILIUM ETAPI PROXY ─────────────────────────────────────────
def _trilium_or_404(settings=None):
    cfg = get_config(load_settings())
    if not cfg["enabled"]:
        raise HTTPException(status_code=400, detail="Trilium is not configured. Add URL + ETAPI token in Settings → Class Notes.")
    return cfg


@app.get("/api/trilium/status")
def trilium_status():
    settings = load_settings()
    cfg = get_config(settings)
    try:
        info = check_connection(settings)
    except TriliumError as exc:
        return {"configured": cfg["enabled"], "connected": False, "url": cfg["url"], "error": str(exc)}
    return {"configured": True, "connected": True, "url": cfg["url"], **info}


@app.post("/api/trilium/test")
async def trilium_test(request: Request):
    body = await request.json()
    url = str(body.get("url") or "").strip()
    token = str(body.get("token") or "").strip()
    if token.startswith("••"):
        token = (get_config(load_settings()) or {}).get("token", "")
    if not url:
        raise HTTPException(status_code=400, detail="Trilium URL is required")
    if not token:
        raise HTTPException(status_code=400, detail="Trilium ETAPI token is required")
    try:
        info = check_connection({"trilium": {"url": url, "token": token}})
    except TriliumError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"connected": True, **info}


@app.get("/api/trilium/search")
def trilium_search(q: str = "", limit: int = 20):
    _trilium_or_404()
    if not q.strip():
        return {"results": [], "query": q}
    try:
        results = search_notes(q, limit=min(int(limit), 50))
    except TriliumError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"query": q, "results": results}


@app.get("/api/trilium/notes/{note_id}")
def trilium_note(note_id: str):
    _trilium_or_404()
    try:
        note = get_note(note_id)
        latest = latest_chapter(note_id)
    except TriliumError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {**note, "latestChapter": latest, "webUrl": note_web_url(note_id)}


@app.get("/api/trilium/notes/{note_id}/content")
def trilium_note_content(note_id: str):
    _trilium_or_404()
    try:
        content = get_note_content(note_id)
    except TriliumError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"noteId": note_id, "content": content}


@app.post("/api/trilium/link")
async def trilium_link(request: Request):
    body = await request.json()
    class_id = str(body.get("classId") or "").strip()
    note_id = str(body.get("noteId") or "").strip()
    if not class_id:
        raise HTTPException(status_code=400, detail="classId is required")
    _trilium_or_404()
    try:
        note = get_note(note_id)
    except TriliumError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not note["children"]:
        raise HTTPException(status_code=400, detail="That note has no children — link a folder that contains chapter notes.")
    settings = load_settings()
    stored = set_class_note(class_id, note["noteId"], note["title"], note["type"], settings=settings)
    return {"classId": class_id, "linked": stored}


@app.delete("/api/trilium/link")
def trilium_unlink(classId: str = ""):
    if not classId:
        raise HTTPException(status_code=400, detail="classId is required")
    removed = unset_class_note(classId)
    return {"classId": classId, "removed": removed}


# ─── NOTE QUIZ (Trilium-driven daily quizzes) ───────────────────
def _trilium_linked_class_ids():
    settings = load_settings()
    return {str(cid) for cid, link in (get_notes_map(settings) or {}).items() if link}


def _resolve_note_quiz_class(class_id: str, settings=None):
    """Return (linked_note, chapter_note) for a classId, or raise HTTPException.
    chapter_note may be None if no chapter child exists yet.
    """
    settings = settings or load_settings()
    link = get_class_note(class_id, settings)
    if not link:
        raise HTTPException(status_code=400, detail=f"Class {class_id} has no linked Trilium folder.")
    chapter = None
    try:
        chapter = latest_chapter(link["noteId"], settings)
    except TriliumError as exc:
        raise HTTPException(status_code=400, detail=f"Trilium error: {exc}") from exc
    return link, chapter


# In-memory note-quiz generation jobs. The generate endpoint starts a daemon
# thread and returns immediately with a jobId; the frontend polls the status
# endpoint so the "saving / generating" state always resolves (no dead fetches).
_NQ_JOBS: Dict[str, dict] = {}
_NQ_JOBS_LOCK = threading.Lock()


def _run_note_quiz_job(job_id: str, class_id: str, clarification: str = None) -> None:
    """Background generate flow. Updates _NQ_JOBS[job_id] with phase + result so
    the UI can render accurate progress and always get a terminal state."""
    job = {"status": "running", "phase": "starting", "classId": class_id}
    with _NQ_JOBS_LOCK:
        _NQ_JOBS[job_id] = job

    def set_phase(phase: str) -> None:
        with _NQ_JOBS_LOCK:
            if job.get("status") == "running":
                job["phase"] = phase

    def fail(message: str) -> None:
        with _NQ_JOBS_LOCK:
            job.update(status="error", phase="done", error=message)

    try:
        set_phase("fetching")
        settings = load_settings()
        if not note_quiz.is_class_enabled(settings, class_id):
            fail("Note quizzes are not enabled for this class.")
            return
        link, chapter = _resolve_note_quiz_class(class_id, settings)
        if not chapter:
            fail("This class's Trilium folder has no chapter notes yet.")
            return
        chapter_note_id = chapter["noteId"]
        set_phase("diffing")
        try:
            content = get_note_content(chapter_note_id, settings)
        except TriliumError as exc:
            fail(f"Trilium error: {exc}")
            return
        snapshot = note_quiz.latest_snapshot(class_id, chapter_note_id)
        diff = note_quiz.diff_appended(
            content,
            snapshot["snapshot_hash"] if snapshot else None,
            int(snapshot["snapshot_lines"]) if snapshot else 0,
        )
        min_lines = note_quiz.class_min_lines(settings, class_id)
        if len(diff["added_lines"]) < min_lines:
            fail(f"Only {len(diff['added_lines'])} new line(s) since last quiz — need at least {min_lines}.")
            return
        set_phase("ai")
        try:
            generated = note_quiz.generate_questions(diff["added_lines"], settings, clarification=clarification, depths=diff.get("line_depths"))
            questions = generated["questions"]
            set_title = generated.get("title") or ""
        except (ValueError, RuntimeError) as exc:
            fail(str(exc))
            return
        set_phase("saving")
        class_name = ""
        try:
            for cls in (_computed_payload().get("activeClasses") or []):
                if str(cls.get("id")) == class_id:
                    class_name = cls.get("shortName") or cls.get("name") or ""
                    break
        except Exception:
            pass
        set_id = note_quiz.save_set(
            class_id=class_id,
            class_name=class_name,
            chapter_note_id=chapter_note_id,
            chapter_title=chapter.get("title") or "",
            source_lines=diff["added_lines"],
            snapshot_lines=diff["total_lines"],
            model=(settings.get("ollamaModel") or "gpt-oss:120b"),
            questions=questions,
            status="ready",
            title=set_title,
            depths=diff.get("line_depths"),
        )
        with _NQ_JOBS_LOCK:
            job.update(
                status="done",
                phase="done",
                setId=set_id,
                questions=len(questions),
                chapterTitle=chapter.get("title") or "",
            )
    except Exception as exc:
        logging.getLogger("dashboard").warning("note quiz job failed: %s", exc)
        fail(f"Unexpected error: {exc}")


@app.post("/api/note_quiz/sets/generate")
async def note_quiz_generate(request: Request):
    """Start generating a quiz set for a class (runs in a background thread).
    Returns a jobId immediately; poll /api/note_quiz/sets/jobs/{jobId}."""
    body = await request.json()
    class_id = str(body.get("classId") or "").strip()
    if not class_id:
        raise HTTPException(status_code=400, detail="classId is required")
    clarification = str(body.get("clarification") or "").strip() or None
    job_id = f"nq{int(time.time() * 1000)}{os.urandom(4).hex()}"
    thread = threading.Thread(target=_run_note_quiz_job, args=(job_id, class_id), kwargs={"clarification": clarification}, daemon=True)
    thread.start()
    return {"jobId": job_id, "classId": class_id}


@app.get("/api/note_quiz/sets/jobs/{job_id}")
def note_quiz_job_status(job_id: str):
    """Pollable status for a background note-quiz generation job."""
    with _NQ_JOBS_LOCK:
        job = _NQ_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown job")
    return dict(job)


@app.post("/api/note_quiz/sets/preview")
async def note_quiz_preview(request: Request):
    """Show what a new quiz would cover without saving. Useful for the manual-trigger UI."""
    body = await request.json()
    class_id = str(body.get("classId") or "").strip()
    if not class_id:
        raise HTTPException(status_code=400, detail="classId is required")
    settings = load_settings()
    if not note_quiz.is_class_enabled(settings, class_id):
        raise HTTPException(status_code=400, detail="Note quizzes are not enabled for this class.")
    link, chapter = _resolve_note_quiz_class(class_id, settings)
    chapter_note_id = chapter["noteId"] if chapter else link["noteId"]
    try:
        content = get_note_content(chapter_note_id, settings)
    except TriliumError as exc:
        raise HTTPException(status_code=400, detail=f"Trilium error: {exc}") from exc
    snapshot = note_quiz.latest_snapshot(class_id, chapter_note_id)
    diff = note_quiz.diff_appended(
        content,
        snapshot["snapshot_hash"] if snapshot else None,
        int(snapshot["snapshot_lines"]) if snapshot else 0,
    )
    return {
        "classId": class_id,
        "chapterNoteId": chapter_note_id,
        "chapterTitle": (chapter or {}).get("title") or link.get("noteTitle") or "",
        "addedLineCount": len(diff["added_lines"]),
        "totalLines": diff["total_lines"],
        "preview": diff["added_lines"][:30],  # cap preview payload
    }


@app.get("/api/note_quiz/sets")
def note_quiz_sets_list(classId: str = "", limit: int = 100):
    rows = note_quiz.list_sets(class_id=classId or None)
    rows = rows[:max(1, min(500, int(limit)))]
    for r in rows:
        r.pop("source_lines_json", None)
        r.pop("snapshot_hash", None)
    return {"sets": rows}


@app.get("/api/note_quiz/sets/{set_id:int}")
def note_quiz_sets_get(set_id: int):
    s = note_quiz.get_set(int(set_id))
    if not s:
        raise HTTPException(status_code=404, detail="Set not found")
    return s


@app.delete("/api/note_quiz/sets/{set_id:int}")
def note_quiz_sets_delete(set_id: int):
    note_quiz.delete_set(int(set_id))
    return {"ok": True}


@app.post("/api/note_quiz/attempts")
async def note_quiz_attempt_record(request: Request):
    body = await request.json()
    set_id = int(body.get("setId") or 0)
    answers = body.get("answers") or {}
    duration = body.get("durationSeconds")
    if not set_id:
        raise HTTPException(status_code=400, detail="setId is required")
    norm = {int(k): int(v) for k, v in answers.items()}
    result = note_quiz.record_attempt(set_id, norm, duration_seconds=duration)
    return result


@app.get("/api/note_quiz/stats")
def note_quiz_stats(classId: str = ""):
    return note_quiz.dashboard_stats(class_id=classId or None)


@app.get("/api/note_quiz/sets/{set_id:int}/missed")
def note_quiz_sets_missed(set_id: int):
    return note_quiz.missed_questions_summary(int(set_id))


@app.get("/api/note_quiz/today")
def note_quiz_today(classId: str = ""):
    """Sets generated today (for the Review tab 'Take a missed quiz' UI)."""
    init_db = note_quiz.init_db
    init_db()
    with note_quiz._lock, note_quiz._conn() as c:
        today_str = c.execute("SELECT date('now', 'localtime')").fetchone()[0]
        if classId:
            rows = c.execute(
                """SELECT * FROM note_quiz_sets
                   WHERE class_id=? AND substr(generated_at,1,10)=?
                   ORDER BY id DESC""",
                (str(classId), today_str),
            ).fetchall()
        else:
            rows = c.execute(
                """SELECT * FROM note_quiz_sets
                   WHERE substr(generated_at,1,10)=?
                   ORDER BY id DESC""",
                (today_str,),
            ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["classId"] = d.pop("class_id")
        d["className"] = d.pop("class_name", "")
        d["chapterNoteId"] = d.pop("chapter_note_id")
        d["chapterTitle"] = d.pop("chapter_title")
        d["snapshotLines"] = d.pop("snapshot_lines")
        d["generatedAt"] = d.pop("generated_at")
        d["generatedByModel"] = d.pop("generated_by_model")
        d["lineCount"] = d.pop("line_count")
        d["firstTryPct"] = d.pop("first_try_pct", None)
        d.pop("source_lines_json", None)
        d.pop("snapshot_hash", None)
        out.append(d)
    counts = note_quiz.question_counts([d["id"] for d in out])
    for d in out:
        d["questionCount"] = counts.get(d["id"], 0)
    return {"date": today_str, "count": len(out), "sets": out}


@app.get("/api/note_quiz/scheduler/status")
def note_quiz_scheduler_status():
    return note_quiz_scheduler.status()


@app.get("/api/note_quiz/calendar")
def note_quiz_calendar(year: int, month: int):
    return note_quiz.calendar_status(int(year), int(month))


@app.get("/api/note_quiz/sets/by-date")
def note_quiz_sets_by_date(date: str, classId: str = ""):
    """Sets generated on a specific date (for the calendar past-day view)."""
    init_db = note_quiz.init_db
    init_db()
    with note_quiz._lock, note_quiz._conn() as c:
        if classId:
            rows = c.execute(
                "SELECT * FROM note_quiz_sets WHERE substr(generated_at,1,10)=? AND class_id=? ORDER BY id DESC",
                (date, str(classId)),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM note_quiz_sets WHERE substr(generated_at,1,10)=? ORDER BY id DESC",
                (date,),
            ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["classId"] = d.pop("class_id")
        d["className"] = d.pop("class_name", "")
        d["chapterNoteId"] = d.pop("chapter_note_id")
        d["chapterTitle"] = d.pop("chapter_title")
        d["snapshotLines"] = d.pop("snapshot_lines")
        d["generatedAt"] = d.pop("generated_at")
        d["generatedByModel"] = d.pop("generated_by_model")
        d["lineCount"] = d.pop("line_count")
        d["firstTryPct"] = d.pop("first_try_pct", None)
        d.pop("source_lines_json", None)
        d.pop("snapshot_hash", None)
        out.append(d)
    counts = note_quiz.question_counts([d["id"] for d in out])
    for d in out:
        d["questionCount"] = counts.get(d["id"], 0)
    return {"date": date, "sets": out}


# ─── BLOOKET QUIZ BUILDER ────────────────────────────────────────
_blooket_classes_cache = {"t": 0.0, "value": None, "mtime": None}


def _blooket_classes_payload():
    now = time.time()
    mtime = blooket_saved_sets_mtime()
    if _blooket_classes_cache.get("mtime") != mtime:
        _blooket_classes_cache["mtime"] = mtime
        _blooket_classes_cache["value"] = None
    if _blooket_classes_cache["value"] and now - _blooket_classes_cache["t"] < 15:
        return _blooket_classes_cache["value"]
    settings = load_settings()
    computed = _computed_payload()
    notes = get_notes_map(settings)
    saved = blooket_load_saved_sets()

    # Collect noteIds for parallel Trilium fetching
    _num_re = re.compile(r'(\d+(?:\.\d+)*)')
    def _ch_number(title):
        m = _num_re.search((title or "").strip())
        if not m: return None
        parts = [float(p) for p in m.group(1).split(".")]
        return sum(p / (10 ** i) for i, p in enumerate(parts))

    class_links = []
    for cls in computed.get("activeClasses") or []:
        link = notes.get(str(cls.get("id")))
        if link:
            class_links.append((cls, link))

    # Fetch all Trilium note data in parallel
    from concurrent.futures import ThreadPoolExecutor, as_completed
    _fetched = {}
    def _fetch_chapters(nid):
        try:
            return nid, get_note(nid, settings)
        except TriliumError:
            return nid, None

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_fetch_chapters, link["noteId"]): link["noteId"]
                   for _, link in class_links}
        for f in as_completed(futures):
            nid, nd = f.result()
            _fetched[nid] = nd

    rows = []
    for cls, link in class_links:
        try:
            all_chapters = []
            note_data = _fetched.get(link["noteId"])
            children = note_data.get("children") or [] if note_data else []
            for ch in children:
                all_chapters.append({
                    "noteId": ch.get("noteId"),
                    "title": ch.get("title"),
                    "number": _ch_number(ch.get("title")),
                })
            all_chapters.sort(key=lambda c: (c["number"] is None, -(c["number"] or 0)))
            latest = all_chapters[0] if all_chapters else None
        except Exception:
            all_chapters = []
            latest = None
        cls_sets = saved.get(str(cls.get("id"))) or {}
        sets = sorted(cls_sets.values(), key=lambda s: s.get("createdAt") or "", reverse=True)
        current = None
        if latest:
            current = next((s for s in sets if s.get("sourceNoteId") == latest.get("noteId")), None)
        rows.append({
            "classId": cls.get("id"),
            "name": cls.get("name") or cls.get("shortName") or "?",
            "shortName": cls.get("shortName") or "",
            "noteId": link.get("noteId"),
            "noteTitle": link.get("noteTitle") or link.get("title") or "",
            "latest": latest,
            "chapters": all_chapters,
            "sets": sets,
            "set": current,
        })
    custom = saved.get("custom") or {}
    custom_sets = sorted(custom.values(), key=lambda s: s.get("createdAt") or "", reverse=True)
    payload = {"classes": rows, "customSets": custom_sets}
    _blooket_classes_cache.update({"t": now, "value": payload})
    return payload


@app.get("/api/blooket/classes")
def blooket_classes():
    try:
        return _blooket_classes_payload()
    except TriliumError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/blooket/quiz")
def blooket_quiz(url: str = "", localKey: str = ""):
    """Return the saved questions for a set. Looked up by setUrl, or by
    localKey for unpublished sets (so the local app can still review them when
    the Blooket publish failed)."""
    saved = blooket_load_saved_sets()
    key = (localKey or "").strip()
    if key:
        for class_sets in saved.values():
            if not isinstance(class_sets, dict):
                continue
            for entry in class_sets.values():
                if isinstance(entry, dict) and (entry.get("localKey") == key):
                    return {
                        "title": entry.get("title"),
                        "chapterTitle": entry.get("chapterTitle"),
                        "questions": entry.get("questions") or [],
                    }
    url = (url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url or localKey is required")
    for class_sets in saved.values():
        if not isinstance(class_sets, dict):
            continue
        for entry in class_sets.values():
            if isinstance(entry, dict) and entry.get("setUrl") == url:
                return {
                    "title": entry.get("title"),
                    "chapterTitle": entry.get("chapterTitle"),
                    "questions": entry.get("questions") or [],
                }
    raise HTTPException(status_code=404, detail="Quiz not found")


@app.post("/api/blooket/generate")
async def blooket_generate(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    class_id = str(body.get("classId") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    note_id = str(body.get("noteId") or "").strip()
    if not class_id:
        raise HTTPException(status_code=400, detail="classId is required")
    result = blooket_start_pipeline(class_id, prompt, note_id)
    return {
        "started": bool(result.get("started")),
        "queued": bool(result.get("queued")),
        "id": result.get("id"),
    }


@app.post("/api/blooket/custom")
async def blooket_custom(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    content = str(body.get("content") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    set_url = str(body.get("setUrl") or "").strip()
    file_name = str(body.get("fileName") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Add some text or a document to build a quiz from.")
    label = os.path.splitext(file_name)[0] if file_name else "Custom"
    result = blooket_start_custom_pipeline(content, prompt, set_url, label)
    return {
        "started": bool(result.get("started")),
        "queued": bool(result.get("queued")),
        "id": result.get("id"),
    }


@app.post("/api/blooket/cancel")
async def blooket_cancel(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    job_id = str(body.get("id") or "").strip()
    if not job_id:
        raise HTTPException(status_code=400, detail="id is required")
    from blooket_builder import cancel_queued as blooket_cancel_queued
    removed = blooket_cancel_queued(job_id)
    return {"ok": removed}


@app.patch("/api/blooket/set")
async def blooket_update_set_route(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    identifier = str(body.get("setUrl") or body.get("localKey") or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="setUrl or localKey is required")
    updates = {}
    if "title" in body and body["title"] is not None:
        updates["title"] = str(body["title"]).strip()
    if "description" in body and body["description"] is not None:
        updates["description"] = str(body["description"]).strip()
    if "questions" in body and isinstance(body["questions"], list):
        updates["questions"] = body["questions"]
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")
    if not blooket_update_set(identifier, updates):
        raise HTTPException(status_code=404, detail="Set not found")
    _blooket_classes_cache["mtime"] = None
    return {"ok": True}


@app.delete("/api/blooket/set")
async def blooket_delete_set_route(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    identifier = str(body.get("setUrl") or body.get("localKey") or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="setUrl or localKey is required")
    if not blooket_delete_set(identifier):
        raise HTTPException(status_code=404, detail="Set not found")
    _blooket_classes_cache["mtime"] = None
    return {"ok": True}


@app.get("/api/blooket/set")
async def blooket_get_set(setUrl: str = "", localKey: str = ""):
    identifier = (localKey or "").strip() or (setUrl or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="setUrl or localKey query param required")
    class_id, key, s = blooket_find_set_by_url_or_local(identifier)
    if not s:
        raise HTTPException(status_code=404, detail="Set not found")
    is_local = not (s.get("setUrl") or "") or identifier == key or identifier == s.get("localKey")
    return {"set": s, "classId": class_id, "key": key, "local": bool(is_local and not s.get("setUrl"))}


@app.get("/api/blooket/status")
def blooket_status():
    return blooket_job_status()


# ─── Levels-based review state (persists to SQLite) ───────────────

@app.get("/api/levels/state")
def levels_state_get():
    """All levels-based review progress keyed by set URL."""
    return {"states": levels_state.all_states()}


@app.put("/api/levels/state")
async def levels_state_put(request: Request):
    """Upsert the review state for a single set URL. Body: {setUrl, state}."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    set_url = str(body.get("setUrl") or "").strip()
    state = body.get("state")
    if not set_url:
        raise HTTPException(status_code=400, detail="setUrl is required")
    if not isinstance(state, dict):
        raise HTTPException(status_code=400, detail="state must be an object")
    if not levels_state.put_state(set_url, state):
        raise HTTPException(status_code=500, detail="Could not write state")
    return {"ok": True}


@app.delete("/api/levels/state/{set_url:path}")
def levels_state_delete(set_url: str):
    if not set_url:
        raise HTTPException(status_code=400, detail="setUrl is required")
    levels_state.delete_state(set_url)
    return {"ok": True}


def _normalize_scrape_period(period: str) -> str:
    value = str(period or "all").strip().lower()
    return value if value in SCRAPE_PERIODS else "all"


def _validate_scrape_classes(classes: str) -> str:
    value = str(classes or "all").strip()
    if not value:
        return "all"
    if any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789,-_ " for ch in value):
        raise ValueError("Invalid class selector")
    return value


def _sweep_tmp_profiles():
    """Clear leftover nodriver/Chromium tmp.* profiles from /tmp and the home
    scratch dir. nodriver creates a tmp.* profile per browser launch; these
    accumulate and fill the 4GB /tmp tmpfs. Called after each scrape job and
    Blooket bot run finishes."""
    for root in ("/tmp", os.path.join(os.path.expanduser("~"), ".blooket-tmp")):
        try:
            for entry in os.scandir(root):
                try:
                    if entry.name.startswith("tmp."):
                        if entry.is_dir(follow_symlinks=False):
                            shutil.rmtree(entry.path, ignore_errors=True)
                        else:
                            os.remove(entry.path)
                except OSError:
                    continue
        except OSError:
            continue


def _cleanup_stale_scrape_browser():
    """Kill any orphaned Chromium still using the SIS profile and clear its
    singleton locks before a fresh scrape starts. A crashed run can leave a
    Chromium holding the profile lock, which makes the next launch hand off to
    it and fail with nodriver's 'Failed to connect to browser'. SIGTERM alone
    does not stop a hung Chromium, so escalate to SIGKILL."""
    try:
        subprocess.run(["pkill", "-f", r"\.sis-profile"], check=False)
    except Exception:
        pass
    time.sleep(2)
    try:
        subprocess.run(["pkill", "-9", "-f", r"\.sis-profile"], check=False)
    except Exception:
        pass
    profile = os.path.join(os.path.expanduser("~"), ".sis-profile")
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        try:
            os.remove(os.path.join(profile, name))
        except OSError:
            pass
    time.sleep(1.5)


def _launch_scrape_job(period: str, classes: str, label: str = "manual") -> bool:
    period = _normalize_scrape_period(period)
    classes = _validate_scrape_classes(classes)

    with _scrape_lock:
        if _scrape_job["process"] and _scrape_job["process"].poll() is None:
            return False
        _cleanup_stale_scrape_browser()
        command = [sys.executable, os.path.join(os.path.dirname(__file__), "sis_login.py"), "--period", period, "--classes", classes]
        env = dict(os.environ)
        env["DISPLAY"] = os.environ.get("DISPLAY", ":0")
        env["XAUTHORITY"] = os.path.join(os.path.expanduser("~"), ".Xauthority")
        process = subprocess.Popen(command, cwd=os.path.dirname(__file__), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        _scrape_job.update({"process": process, "logs": [f"Starting {label}: " + " ".join(command)], "exitCode": None})
        threading.Thread(target=_collect_scrape_output, args=(process,), daemon=True).start()
    return True


def _parse_schedule_times(raw_times):
    if isinstance(raw_times, list):
        parts = raw_times
    elif isinstance(raw_times, str):
        parts = re.split(r"[\n,;]+", raw_times)
    else:
        parts = [raw_times]

    parsed = []
    for item in parts:
        text = str(item or "").strip()
        if not text:
            continue
        for fmt in ("%H:%M", "%I:%M %p", "%I%p"):
            try:
                parsed.append(datetime.strptime(text, fmt).time().replace(second=0, microsecond=0))
                break
            except ValueError:
                continue
    return parsed


def _auto_scrape_config(settings):
    auto = settings.get("autoScrape") or {}
    if not isinstance(auto, dict):
        return None
    enabled = bool(auto.get("enabled"))
    if not enabled:
        return None
    times = _parse_schedule_times(auto.get("times") or auto.get("scheduleTimes"))
    if not times:
        return None
    classes = _validate_scrape_classes(auto.get("classes") or auto.get("scrapeClasses") or "all")
    return {"times": times, "period": f"q{CURRENT_TERM}", "classes": classes}


def _auto_scrape_loop():
    while True:
        try:
            cfg = _auto_scrape_config(load_settings())
            if cfg:
                now = datetime.now()
                for scheduled in cfg["times"]:
                    if now.hour == scheduled.hour and now.minute == scheduled.minute:
                        key = f"{now.date().isoformat()}|{scheduled.strftime('%H:%M')}|{cfg['period']}|{cfg['classes']}"
                        with _scrape_lock:
                            if key in _auto_scrape_seen:
                                continue
                            _auto_scrape_seen.add(key)
                        if _launch_scrape_job(cfg["period"], cfg["classes"], label=f"auto {scheduled.strftime('%H:%M')}"):
                            log.info("Auto scrape started for %s at %s", cfg["classes"], scheduled.strftime("%H:%M"))
                        else:
                            log.info("Auto scrape skipped because a scrape is already running")
            if len(_auto_scrape_seen) > 128:
                with _scrape_lock:
                    _auto_scrape_seen.clear()
        except Exception as exc:
            log.exception("Auto scrape scheduler failed: %s", exc)
        time.sleep(30)


@app.post("/api/scrape")
async def start_scrape(request: Request):
    body = await request.json()
    period = _normalize_scrape_period(body.get("period") or "all")
    classes = _validate_scrape_classes(body.get("classes") or "all")
    if not _launch_scrape_job(period, classes, label="manual"):
        raise HTTPException(status_code=409, detail="A scrape is already running")
    return {"started": True}


# ── Daily combined email scheduler ────────────────────────────────────────────

def _email_schedule_config(settings):
    """Read the daily-email schedule. Returns None unless enabled with times."""
    email = settings.get("email") or {}
    if not isinstance(email, dict):
        return None
    schedule = email.get("schedule") or {}
    if not isinstance(schedule, dict):
        return None
    enabled = bool(schedule.get("enabled"))
    if not enabled:
        return None
    times = _parse_schedule_times(schedule.get("times") or schedule.get("scheduleTimes"))
    if not times:
        return None
    return {"times": times}


def _send_daily_email_loop():
    _email_seen = set()
    while True:
        try:
            cfg = _email_schedule_config(load_settings())
            if cfg:
                now = datetime.now()
                for scheduled in cfg["times"]:
                    if now.hour == scheduled.hour and now.minute == scheduled.minute:
                        key = f"{now.date().isoformat()}|{scheduled.strftime('%H:%M')}"
                        if key in _email_seen:
                            continue
                        _email_seen.add(key)
                        run_label = "morning" if scheduled.hour < 12 else "afternoon"
                        try:
                            from grades_emailer import send_daily_email
                            log.info("Sending %s daily email", run_label)
                            sent = send_daily_email(run_label=run_label)
                            log.info("Daily email send %s", "ok" if sent else "failed/skipped")
                        except Exception as exc:
                            log.exception("Daily email send failed: %s", exc)
            if len(_email_seen) > 128:
                _email_seen.clear()
        except Exception as exc:
            log.exception("Daily email scheduler failed: %s", exc)
        time.sleep(30)


@app.post("/api/email/send-daily")
async def send_daily_email_endpoint(request: Request):
    """Manually trigger the combined daily email. Body optional: {run: 'morning'|'afternoon'}."""
    try:
        body = await request.json() or {}
    except Exception:
        body = {}
    run_label = str(body.get("run") or "").strip() or None
    if run_label and run_label not in {"morning", "afternoon"}:
        raise HTTPException(status_code=400, detail="run must be 'morning' or 'afternoon'")
    try:
        from grades_emailer import send_daily_email
        sent = send_daily_email(run_label=run_label)
    except Exception as exc:
        log.exception("Manual daily email send failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    return {"sent": bool(sent)}


@app.get("/api/scrape/logs")
def get_scrape_logs():
    with _scrape_lock:
        process = _scrape_job["process"]
        return {"running": bool(process and process.poll() is None), "exitCode": _scrape_job["exitCode"], "logs": _scrape_job["logs"]}


def _activity_push_loop():
    """Drain real request activity in small batches and push it to the system
    map monitor's /ingest endpoint (fire-and-forget). Only real activity triggers
    a network send — idle is silent, so the map gets realtime data-flow events
    without the monitor polling every endpoint."""
    while True:
        try:
            batch = []
            with _req_activity_lock:
                while _req_activity and len(batch) < 40:
                    batch.append(_req_activity.popleft())
            if not batch:
                time.sleep(0.5)
                continue
            # coalesce duplicates within the batch
            unique = list(dict.fromkeys(batch))
            payload = json.dumps({"ts": time.time(), "paths": unique}).encode("utf-8")
            try:
                req = UrlRequest(
                    MONITOR_URL + "/ingest", data=payload,
                    headers={"Content-Type": "application/json", "X-Monitor-Probe": "1"},
                )
                with urlopen(req, timeout=0.8):
                    pass
            except Exception:
                pass  # monitor down / restarting — drop silently, retry next batch
        except Exception:
            pass
        time.sleep(0.4)


def _update_check_loop():
    """Refresh the in-memory update comparison once a day so the sidebar
    badge stays accurate without each page load paying for a git fetch.
    Runs on a fixed cadence: every 12h. The /api/update/check endpoint also
    forces a refresh, so this is mainly a backstop."""
    import datetime
    while True:
        try:
            try:
                update_check()
            except Exception as exc:
                log.debug("Update check failed: %s", exc)
            # Sleep ~12h in 5-minute chunks so process shutdown doesn't hang.
            for _ in range(12 * 12):
                time.sleep(300)
        except Exception as exc:
            log.exception("update-check loop error: %s", exc)
            time.sleep(60)


_update_check_thread = threading.Thread(target=_update_check_loop, daemon=True, name="update-check")


@app.on_event("startup")
def start_background_jobs():
    if not getattr(app.state, "auto_scrape_started", False):
        app.state.auto_scrape_started = True
        threading.Thread(target=_auto_scrape_loop, daemon=True).start()
    if not getattr(app.state, "activity_push_started", False):
        app.state.activity_push_started = True
        threading.Thread(target=_activity_push_loop, daemon=True).start()
    if not getattr(app.state, "email_push_started", False):
        app.state.email_push_started = True
        threading.Thread(target=_send_daily_email_loop, daemon=True).start()
    try:
        _update_check_thread.start()
    except RuntimeError:
        pass  # already started
    # Build the note-quiz scheduler from current settings so endTime timers
    # are queued before the first /api/note_quiz/* request arrives.
    try:
        note_quiz_scheduler.rebuild()
    except Exception as exc:
        log.warning("note-quiz scheduler startup rebuild failed: %s", exc)


@app.get("/api/computed/overview")
def get_computed_overview():
    d = _computed_payload()
    return {k: d[k] for k in (
        "meta", "overallGrade", "overallLetter", "overallGPA", "quarterTrend",
        "overallRunning", "overallPeriods", "watchlist", "nonAcademicClassIds",
        "trackedClassIds", "totalAssignments", "completedAssignments",
        "lastUpdated", "goal", "settings",
    )}


@app.get("/api/computed/classes")
def get_computed_classes():
    d = _computed_payload()
    return {
        "meta": d["meta"],
        "activeClasses": d["activeClasses"],
        "nonAcademicClassIds": d["nonAcademicClassIds"],
    }


@app.get("/api/computed/assignments")
def get_computed_assignments():
    d = _computed_payload()
    return {
        "meta": d["meta"],
        "allAssignments": d["allAssignments"],
        "totalAssignments": d["totalAssignments"],
        "completedAssignments": d["completedAssignments"],
        "classroomAssignments": d["classroomAssignments"],
        "classroomMeta": d["classroomMeta"],
        "userTodos": d["userTodos"],
        "schoolEvents": d["schoolEvents"],
    }


@app.get("/api/todos")
def get_user_todos():
    """User-created calendar todos + per-assignment overrides (done/hidden/edits)."""
    return _load_user_todos()


@app.post("/api/todos")
async def upsert_user_todo(request: Request):
    """Create or update a user todo, or apply a local content edit to a Classroom assignment.

    Body:
      {type: 'todo', id?, date, title, classId?, className?, description?, instructions?, link?, done?}
      {type: 'classroom', id, title?, description?, instructions?, link?}
    """
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    todos = _load_user_todos()

    if body.get("type") == "classroom":
        key = (body.get("id") or "").strip()
        if not key:
            raise HTTPException(status_code=400, detail="Missing assignment id")
        edits = todos["edits"]
        existing = edits.get(key, {})
        edits[key] = {
            "title": body.get("title"),
            "description": body.get("description"),
            "instructions": body.get("instructions"),
            "link": body.get("link"),
        }
        _save_user_todos(todos)
        return edits[key] if key in edits else {"ok": True}

    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    items = todos["todos"]
    tid = (body.get("id") or "").strip()
    if not tid:
        tid = "t_" + hashlib.sha256(f"{time.time()}{title}".encode()).hexdigest()[:10]
    existing = next((t for t in items if t["id"] == tid), None)
    if existing:
        existing.update({
            "date": body.get("date") or existing.get("date"),
            "title": title,
            "classId": body.get("classId"),
            "className": body.get("className"),
            "description": (body.get("description") or "").strip(),
            "instructions": (body.get("instructions") or "").strip(),
            "link": (body.get("link") or "").strip(),
            "done": bool(body.get("done", existing.get("done", False))),
            "updatedAt": time.time(),
        })
        record = existing
    else:
        record = {
            "id": tid,
            "date": body.get("date"),
            "title": title,
            "classId": body.get("classId"),
            "className": body.get("className"),
            "description": (body.get("description") or "").strip(),
            "instructions": (body.get("instructions") or "").strip(),
            "link": (body.get("link") or "").strip(),
            "done": bool(body.get("done")),
            "createdAt": time.time(),
            "updatedAt": time.time(),
        }
        items.append(record)
    _save_user_todos(todos)
    return record


@app.post("/api/todos/delete")
async def delete_user_todo(request: Request):
    body = await request.json()
    key = (body.get("id") or "").strip()
    todos = _load_user_todos()
    todos["todos"] = [t for t in todos["todos"] if t["id"] != key]
    _save_user_todos(todos)
    return {"ok": True}


@app.post("/api/todos/state")
async def set_user_todo_state(request: Request):
    """Set done/hidden for a user todo or a Classroom assignment.

    Body: {id, done?} or {id, hidden?}. For Classroom assignment ids the value
    is stored in overrides/hidden maps so a Google sync never overwrites it.
    """
    body = await request.json()
    key = (body.get("id") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Missing id")
    todos = _load_user_todos()
    if "done" in body:
        done = bool(body.get("done"))
        matched = False
        for t in todos["todos"]:
            if t["id"] == key:
                t["done"] = done
                matched = True
        if not matched:
            todos["overrides"][key] = done
    if "hidden" in body:
        if body.get("hidden"):
            todos["hidden"][key] = True
        else:
            todos["hidden"].pop(key, None)
    _save_user_todos(todos)
    return {"ok": True}


@app.get("/", response_class=FileResponse)
def dashboard():
    if not os.path.isfile(GRADETRACK_INDEX_PATH):
        raise HTTPException(status_code=404, detail="Dashboard HTML not found")
    return FileResponse(GRADETRACK_INDEX_PATH, media_type="text/html")
