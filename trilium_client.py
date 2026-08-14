#!/usr/bin/env python3
"""
Trilium ETAPI client for GradeTrack.

Talks to Trilium's built-in external API (ETAPI) on the same port as the web
UI (e.g. http://192.168.0.71:8081/etapi/). All settings (URL + token + the
class->note mapping) live in data/settings.json under the "trilium" key.

Nothing here talks to the browser directly; dashboard_server.py exposes these
helpers through /api/trilium/* routes.
"""

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor

import requests

# Validate note/branch ids which are alphanumeric (4-32 chars)
_NOTE_ID_RE = re.compile(r"^[A-Za-z0-9_]{4,32}$")
_NUM_RE = re.compile(r"([0-9]+(?:\.[0-9]+)*)")

SETTINGS_PATH = os.path.join(os.path.dirname(__file__), "data", "settings.json")

DEFAULT_URL = "http://192.168.0.71:8081"
_TIMEOUT = 15


# ── Settings helpers ─────────────────────────────────────────────
def _read_settings():
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def _write_settings(data):
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    with open(SETTINGS_PATH, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)


def _trilium_block(settings=None):
    settings = settings if settings is not None else _read_settings()
    block = settings.get("trilium")
    if not isinstance(block, dict):
        return {}
    return block


def get_config(settings=None):
    """Return {url, token, enabled} for the ETAPI."""
    block = _trilium_block(settings)
    url = str(block.get("url") or DEFAULT_URL).strip().rstrip("/")
    token = str(block.get("token") or "").strip()
    return {
        "url": url,
        "token": token,
        "enabled": bool(url and token),
    }


def save_config(url=None, token=None, settings=None):
    """Persist URL/token into settings.json, preserving the notes mapping."""
    data = settings if settings is not None else _read_settings()
    block = dict(data.get("trilium") or {})
    if url is not None:
        block["url"] = str(url).strip().rstrip("/")
    if token is not None and str(token).strip():
        block["token"] = str(token).strip()
    block.setdefault("notes", {})
    data["trilium"] = block
    _write_settings(data)
    return data


# ── Note mapping (class -> note) ─────────────────────────────────
def get_notes_map(settings=None):
    return _trilium_block(settings).get("notes") or {}


def get_class_note(class_id, settings=None):
    return get_notes_map(settings).get(str(class_id))


def set_class_note(class_id, note_id, note_title, note_type, settings=None):
    data = settings if settings is not None else _read_settings()
    block = dict(data.get("trilium") or {})
    notes = dict(block.get("notes") or {})
    notes[str(class_id)] = {
        "noteId": note_id,
        "noteTitle": note_title,
        "noteType": note_type,
        "url": note_web_url(note_id),
    }
    block["notes"] = notes
    data["trilium"] = block
    _write_settings(data)
    return notes[str(class_id)]


def unset_class_note(class_id, settings=None):
    data = settings if settings is not None else _read_settings()
    block = dict(data.get("trilium") or {})
    notes = dict(block.get("notes") or {})
    removed = notes.pop(str(class_id), None)
    block["notes"] = notes
    data["trilium"] = block
    _write_settings(data)
    return bool(removed)


# ── Core ETAPI calls ─────────────────────────────────────────────
def _etapi_base(settings=None):
    cfg = get_config(settings)
    return f"{cfg['url']}/etapi"


def _headers(settings=None):
    cfg = get_config(settings)
    if not cfg["token"]:
        raise TriliumError("Trilium ETAPI token is not set. Add it in Settings → Class Notes.")
    return {"Authorization": cfg["token"]}


def _get(path, settings=None, **kwargs):
    base = _etapi_base(settings)
    try:
        resp = requests.get(
            f"{base}{path}",
            headers=_headers(settings),
            timeout=_TIMEOUT,
            **kwargs,
        )
    except requests.exceptions.ConnectionError:
        raise TriliumError(f"Cannot connect to Trilium at {base}")
    except requests.exceptions.Timeout:
        raise TriliumError(f"Timed out talking to Trilium at {base}")
    if resp.status_code == 401:
        raise TriliumError("Trilium ETAPI token rejected (401). Check the token in Settings.")
    if resp.status_code == 404:
        raise TriliumError("Trilium note not found (404).")
    if resp.status_code != 200:
        raise TriliumError(f"Trilium returned HTTP {resp.status_code}: {resp.text[:200]}")
    return resp


def check_connection(settings=None):
    """Return {connected, version, appName} or raise TriliumError."""
    cfg = get_config(settings)
    if not cfg["url"]:
        raise TriliumError("Trilium URL is not set.")
    if not cfg["token"]:
        raise TriliumError("Trilium ETAPI token is not set.")
    resp = _get("/app-info", settings)
    info = resp.json()
    return {
        "connected": True,
        "appName": info.get("appName"),
        "version": info.get("version"),
        "utcDateTime": info.get("utcDateTime"),
    }


def search_notes(query, limit=20, settings=None):
    """Fulltext search. Returns [{noteId, title, type, hasChildren}] for notes
    that have children (folders containing chapter notes)."""
    if not query or not str(query).strip():
        return []
    resp = _get("/notes", settings, params={"search": query.strip(), "limit": int(limit)})
    payload = resp.json()
    results = []
    for item in (payload.get("results") or []):
        child_ids = item.get("childNoteIds") or []
        if not child_ids:
            continue
        results.append({
            "noteId": item.get("noteId"),
            "title": item.get("title"),
            "type": item.get("type"),
            "hasChildren": True,
            "childCount": len(child_ids),
        })
    return results


def get_note(note_id, settings=None):
    """Note metadata + direct children (chapter notes), each with title, type,
    hasChildren and the modification dates used for latest-chapter detection."""
    _validate_note_id(note_id)
    resp = _get(f"/notes/{note_id}", settings)
    data = resp.json()
    child_ids = data.get("childNoteIds") or []
    children = []
    if child_ids:
        def fetch(child_id):
            try:
                child = _get(f"/notes/{child_id}", settings).json()
                sub = child.get("childNoteIds") or []
                return {
                    "noteId": child.get("noteId"),
                    "title": child.get("title"),
                    "type": child.get("type"),
                    "hasChildren": len(sub) > 0,
                    "childCount": len(sub),
                    "dateModified": child.get("dateModified"),
                    "utcDateModified": child.get("utcDateModified"),
                }
            except Exception:
                return None
        with ThreadPoolExecutor(max_workers=8) as pool:
            fetched = list(pool.map(fetch, child_ids[:50]))
        children = [c for c in fetched if c]
    return {
        "noteId": data.get("noteId"),
        "title": data.get("title"),
        "type": data.get("type"),
        "children": children,
    }


def get_note_content(note_id, settings=None):
    """Raw note content as text/plain (used later for latest chapter)."""
    _validate_note_id(note_id)
    resp = _get(f"/notes/{note_id}/content", settings)
    return resp.text


def latest_chapter(note_id, settings=None):
    """Pick the most advanced chapter child of a folder.

    Chapter numbers are detected anywhere in the child title (e.g. 'Ch.16
    Animals', 'Ch.1[title here]'); the highest number wins. When no child has
    a number, the most recently modified child wins. Returns {noteId, title,
    number, dateModified, utcDateModified} or None when the note has no
    children.
    """
    note = get_note(note_id, settings)
    children = note["children"]
    if not children:
        return None

    def number_of(title):
        match = _NUM_RE.search((title or "").strip())
        if not match:
            return None
        parts = [float(p) for p in match.group(1).split(".")]
        return sum(p / (10 ** i) for i, p in enumerate(parts))

    def sort_date(child):
        return child.get("utcDateModified") or child.get("dateModified") or ""

    def summarize(child, number):
        return {
            "noteId": child["noteId"],
            "title": child["title"],
            "number": number,
            "dateModified": child.get("dateModified"),
            "utcDateModified": child.get("utcDateModified"),
        }

    numbered = [(number_of(ch.get("title")), ch) for ch in children]
    numbered = [(num, ch) for num, ch in numbered if num is not None]
    if numbered:
        best_num, best_child = max(numbered, key=lambda item: (item[0], sort_date(item[1])))
        return summarize(best_child, best_num)

    best_child = max(children, key=sort_date)
    return summarize(best_child, None)


def note_web_url(note_id, settings=None):
    """URL that opens a note in the Trilium web UI."""
    _validate_note_id(note_id)
    cfg = get_config(settings)
    return f"{cfg['url']}/#root/{note_id}"


# ── Validation ───────────────────────────────────────────────────
def _validate_note_id(note_id):
    if not _NOTE_ID_RE.match(str(note_id or "")):
        raise TriliumError(f"Invalid Trilium note id: {note_id!r}")


class TriliumError(Exception):
    """Raised for expected Trilium failures (connection, auth, missing)."""
