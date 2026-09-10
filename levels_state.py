"""Levels-based review state persistence for GradeTrack.

The levels quiz runner keeps per-set state (each question card's level, misses,
the in-progress round queue, mastery flag, etc.) so a learner can resume review
where they left off. This state used to live in localStorage; it now persists to
the same SQLite DB as note_quiz so progress survives across browsers/machines.
"""

import json
import os
import sqlite3
import threading
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "facts.db")

_lock = threading.Lock()


def _now_local() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db() -> None:
    """Idempotent. Creates the levels_state table on first run."""
    with _lock, _conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS levels_state (
            set_url TEXT PRIMARY KEY,
            state_json TEXT NOT NULL,
            updated TEXT NOT NULL
        );
        """)


def all_states() -> dict:
    """Return {set_url: parsed_state} for every stored set."""
    init_db()
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT set_url, state_json FROM levels_state"
        ).fetchall()
    out = {}
    for r in rows:
        try:
            out[r["set_url"]] = json.loads(r["state_json"])
        except Exception:
            continue
    return out


def get_state(set_url: str):
    init_db()
    if not set_url:
        return None
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT state_json FROM levels_state WHERE set_url=?",
            (set_url,),
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["state_json"])
    except Exception:
        return None


def put_state(set_url: str, state: dict) -> bool:
    if not set_url or not isinstance(state, dict):
        return False
    init_db()
    with _lock, _conn() as c:
        c.execute(
            """INSERT INTO levels_state (set_url, state_json, updated)
               VALUES (?, ?, ?)
               ON CONFLICT(set_url) DO UPDATE SET
                 state_json=excluded.state_json,
                 updated=excluded.updated""",
            (set_url, json.dumps(state), _now_local()),
        )
    return True


def delete_state(set_url: str) -> bool:
    if not set_url:
        return False
    init_db()
    with _lock, _conn() as c:
        c.execute("DELETE FROM levels_state WHERE set_url=?", (set_url,))
    return True
