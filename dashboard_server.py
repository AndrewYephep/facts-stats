"""FastAPI server to serve the dashboard HTML behind Cloudflare Access."""

import json
import hashlib
import hmac
import logging
import os
import re
import subprocess
import sys
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs
from urllib.request import Request as UrlRequest, urlopen
from typing import Optional

import bcrypt
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
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
from ai_insights import ask_question, get_saved_insights, remove_manual_insight, _grade_math
from blooket_builder import job_status as blooket_job_status
from blooket_builder import start_pipeline as blooket_start_pipeline
from blooket_builder import start_custom_pipeline as blooket_start_custom_pipeline
from blooket_builder import load_saved_sets as blooket_load_saved_sets
from blooket_builder import saved_sets_mtime as blooket_saved_sets_mtime
from blooket_builder import find_set_by_url as blooket_find_set_by_url
from blooket_builder import update_set as blooket_update_set
from blooket_builder import delete_set as blooket_delete_set
from trilium_client import (
    TriliumError,
    check_connection,
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
    return result


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

    return {"success": True}


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


def _computed_payload():
    key = (
        os.path.getmtime(GRADES_JSON_PATH) if os.path.isfile(GRADES_JSON_PATH) else 0,
        os.path.getmtime(GRADES_HISTORY_PATH) if os.path.isfile(GRADES_HISTORY_PATH) else 0,
        os.path.getmtime(SETTINGS_PATH) if os.path.isfile(SETTINGS_PATH) else 0,
        os.path.getmtime(NEW_GRADES_PATH) if os.path.isfile(NEW_GRADES_PATH) else 0,
        os.path.getmtime(CLASSROOM_ASSIGNMENTS_PATH) if os.path.isfile(CLASSROOM_ASSIGNMENTS_PATH) else 0,
        os.path.getmtime(USER_TODOS_PATH) if os.path.isfile(USER_TODOS_PATH) else 0,
    )
    if _compute_cache["key"] == key:
        return _compute_cache["value"]

    raw = _read_json(GRADES_JSON_PATH)
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
    payload["classroomAssignments"] = assignments
    payload["classroomMeta"] = {
        "count": len(payload["classroomAssignments"]),
        "receivedAt": classroom.get("received_at"),
        "receivedAtIso": classroom.get("received_at_iso"),
    }
    payload["userTodos"] = _load_user_todos()

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
    try:
        result = ask_question(_computed_payload(), load_settings(), question, body.get("conversation") or [])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return result


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
    rows = []
    for cls in computed.get("activeClasses") or []:
        link = notes.get(str(cls.get("id")))
        if not link:
            continue
        try:
            latest = latest_chapter(link["noteId"], settings)
        except TriliumError:
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
def blooket_quiz(url: str = ""):
    """Return the saved questions for a set, looked up by its setUrl."""
    url = (url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    saved = blooket_load_saved_sets()
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
    if not class_id:
        raise HTTPException(status_code=400, detail="classId is required")
    if not blooket_start_pipeline(class_id, prompt):
        raise HTTPException(status_code=409, detail="A Blooket generation is already running")
    return {"started": True}


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
    if not blooket_start_custom_pipeline(content, prompt, set_url, label):
        raise HTTPException(status_code=409, detail="A Blooket generation is already running")
    return {"started": True}


@app.patch("/api/blooket/set")
async def blooket_update_set_route(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    set_url = str(body.get("setUrl") or "").strip()
    if not set_url:
        raise HTTPException(status_code=400, detail="setUrl is required")
    updates = {}
    if "title" in body and body["title"] is not None:
        updates["title"] = str(body["title"]).strip()
    if "description" in body and body["description"] is not None:
        updates["description"] = str(body["description"]).strip()
    if "questions" in body and isinstance(body["questions"], list):
        updates["questions"] = body["questions"]
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")
    if not blooket_update_set(set_url, updates):
        raise HTTPException(status_code=404, detail="Set not found")
    _blooket_classes_cache["mtime"] = None
    return {"ok": True}


@app.delete("/api/blooket/set")
async def blooket_delete_set_route(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    set_url = str(body.get("setUrl") or "").strip()
    if not set_url:
        raise HTTPException(status_code=400, detail="setUrl is required")
    if not blooket_delete_set(set_url):
        raise HTTPException(status_code=404, detail="Set not found")
    _blooket_classes_cache["mtime"] = None
    return {"ok": True}


@app.get("/api/blooket/set")
async def blooket_get_set(setUrl: str = ""):
    set_url = setUrl.strip()
    if not set_url:
        raise HTTPException(status_code=400, detail="setUrl query param required")
    class_id, key, s = blooket_find_set_by_url(set_url)
    if not s:
        raise HTTPException(status_code=404, detail="Set not found")
    return {"set": s, "classId": class_id, "key": key}


@app.get("/api/blooket/status")
def blooket_status():
    return blooket_job_status()


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
        env["DISPLAY"] = ":1"
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


@app.get("/api/scrape/logs")
def get_scrape_logs():
    with _scrape_lock:
        process = _scrape_job["process"]
        return {"running": bool(process and process.poll() is None), "exitCode": _scrape_job["exitCode"], "logs": _scrape_job["logs"]}


@app.on_event("startup")
def start_background_jobs():
    if not getattr(app.state, "auto_scrape_started", False):
        app.state.auto_scrape_started = True
        threading.Thread(target=_auto_scrape_loop, daemon=True).start()


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
