"""Daily note quiz generator + tracker.

Stores note-derived quiz sets and per-line color state in SQLite. A set is
one (class, chapter) snapshot of appended lines and the questions the AI
authored from those lines. Color state per line escalates across attempts:
green (first-try correct) → red (wrong) → yellow (recovered) → bright_red
(wrong again after already red).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from urllib.request import Request, urlopen

from ai_insights import _ollama_request_message


# ── Paths ─────────────────────────────────────────────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), "data", "facts.db")
_DEFAULT_OLLAMA_URL = "https://ollama.com/api/chat"


# ── DB helpers ────────────────────────────────────────────────────
_lock = threading.Lock()


def _now_local() -> str:
    """Local wall-clock timestamp (EDT) as an ISO string with no tz offset.

    All day-bucketing in this app (calendar, 'today', streaks) is done by
    comparing the stored string's first 10 chars against a local date, so we
    store local time — not UTC.
    """
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db() -> None:
    """Idempotent. Creates tables on first run."""
    with _lock, _conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS note_quiz_sets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id TEXT NOT NULL,
            class_name TEXT,
            chapter_note_id TEXT NOT NULL,
            chapter_title TEXT,
            title TEXT,
            snapshot_lines INTEGER NOT NULL,
            snapshot_hash TEXT NOT NULL,
            source_lines_json TEXT NOT NULL,
            line_count INTEGER NOT NULL,
            generated_at TEXT NOT NULL,
            generated_by_model TEXT,
            status TEXT NOT NULL DEFAULT 'ready'
        );

        CREATE TABLE IF NOT EXISTS note_quiz_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            set_id INTEGER NOT NULL REFERENCES note_quiz_sets(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            choices_json TEXT NOT NULL,
            correct_index INTEGER NOT NULL,
            explanation TEXT,
            note_line_start INTEGER NOT NULL,
            note_line_end INTEGER NOT NULL,
            color_state TEXT NOT NULL DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS note_quiz_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            set_id INTEGER NOT NULL REFERENCES note_quiz_sets(id) ON DELETE CASCADE,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            score INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0,
            missed_question_ids_json TEXT,
            line_outcomes_json TEXT
        );

        CREATE TABLE IF NOT EXISTS note_quiz_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            set_id INTEGER NOT NULL REFERENCES note_quiz_sets(id) ON DELETE CASCADE,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            color_state TEXT NOT NULL DEFAULT 'pending',
            attempts_wrong INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_nqs_class ON note_quiz_sets(class_id);
        CREATE INDEX IF NOT EXISTS idx_nqs_chapter ON note_quiz_sets(chapter_note_id);
        CREATE INDEX IF NOT EXISTS idx_nq_q_set ON note_quiz_questions(set_id);
        CREATE INDEX IF NOT EXISTS idx_nqa_set ON note_quiz_attempts(set_id);
        CREATE INDEX IF NOT EXISTS idx_nql_set ON note_quiz_lines(set_id);
        """)
        cols = {row[1] for row in c.execute("PRAGMA table_info(note_quiz_sets)")}
        if "title" not in cols:
            c.execute("ALTER TABLE note_quiz_sets ADD COLUMN title TEXT")
        cols = {row[1] for row in c.execute("PRAGMA table_info(note_quiz_sets)")}
        if "first_try_pct" not in cols:
            c.execute("ALTER TABLE note_quiz_sets ADD COLUMN first_try_pct REAL")
        _migrate_utc_to_local(c)
        _backfill_first_try_pct(c)


def _backfill_first_try_pct(c) -> None:
    """Set first_try_pct from the earliest attempt of each set when missing."""
    rows = c.execute(
        "SELECT n.id, a.score, a.total FROM note_quiz_sets n "
        "LEFT JOIN note_quiz_attempts a ON a.id = ("
        "  SELECT id FROM note_quiz_attempts WHERE set_id=n.id ORDER BY id ASC LIMIT 1"
        ") WHERE n.first_try_pct IS NULL AND a.id IS NOT NULL AND a.total > 0"
    ).fetchall()
    for r in rows:
        c.execute(
            "UPDATE note_quiz_sets SET first_try_pct=? WHERE id=?",
            (round(r["score"] * 100.0 / r["total"], 1), r["id"]),
        )


def _migrate_utc_to_local(c) -> None:
    """One-time: convert legacy UTC (+00:00) timestamps to local (EDT) time.

    Earlier builds stored `datetime.now(timezone.utc).isoformat()` (with a
    trailing +00:00). Day bucketing everywhere compares the first 10 chars
    against a local date, so those rows would land on the wrong (next) day.
    """
    from datetime import timedelta
    for table, col in (
        ("note_quiz_sets", "generated_at"),
        ("note_quiz_attempts", "started_at"),
        ("note_quiz_attempts", "finished_at"),
    ):
        try:
            rows = c.execute(f"SELECT id, {col} FROM {table}").fetchall()
        except Exception:
            continue
        for r in rows:
            v = r[col]
            if not v or "+" not in v and not v.endswith("Z"):
                continue
            try:
                if v.endswith("Z"):
                    v = v[:-1] + "+00:00"
                dt = datetime.fromisoformat(v).replace(tzinfo=None)
                local = dt - timedelta(hours=4)  # EDT == UTC-4
                c.execute(f"UPDATE {table} SET {col}=? WHERE id=?", (local.strftime("%Y-%m-%dT%H:%M:%S"), r["id"]))
            except Exception:
                continue


# ── Diff engine ───────────────────────────────────────────────────
def _hash_lines(lines: List[str]) -> str:
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def _split_nonblank(lines: List[Tuple[int, str]]) -> List[Tuple[int, str]]:
    return [(i, txt) for i, txt in lines if (txt or "").strip()]


def _line_visible_text(line_html: str) -> str:
    """Visible text from a line's inner HTML (for hashing/diff)."""
    if not line_html:
        return ""
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        import re as _re
        return _re.sub(r"<[^>]+>", " ", line_html)
    soup = BeautifulSoup(line_html, "html.parser")
    return soup.get_text(" ", strip=True)


def html_to_lines(content: str) -> List[Tuple[int, str]]:
    """Split Trilium HTML into one entry per logical line.

    Returns [(line_index, inner_html), ...] where inner_html preserves the
    inline markup (bold, italic, lists) of that line. Used for both diffing
    AND display, so the line indices line up perfectly.

    Walks ALL block-level descendants recursively, not just top-level
    children. This matters because users frequently paste new content INSIDE
    existing divs (e.g. adding a new section after the existing content
    within the same div) — a top-level-only walker would silently miss it.

    Each of these becomes its own line:
      - <p>, <h1>..<h6>
      - <li> (each list item is its own line)
      - <tr> (each table row is its own line)
      - <hr>
      - <div>, <section>, <article>, <blockquote>, <pre> with inline content
      - <div> with nested block content: walk children instead

    Empty / whitespace-only lines are skipped so line indices stay tight.
    """
    if not content:
        return []
    s = str(content)
    if "<" not in s:
        lines = s.splitlines()
        return [(i, _escape_text(line)) for i, line in enumerate(lines)]

    try:
        from bs4 import BeautifulSoup, NavigableString, Tag
    except ImportError:
        return [(0, s)]

    soup = BeautifulSoup(s, "html.parser")
    for el in soup(["script", "style"]):
        el.decompose()

    out: List[Tuple[int, str]] = []
    _line_depths: dict = {}
    idx = [0]
    depth = [0]

    def append_line(html_fragment: str):
        _line_depths[idx[0]] = depth[0]
        out.append((idx[0], html_fragment))
        idx[0] += 1

    BLOCK_LEVELS = {
        "p", "h1", "h2", "h3", "h4", "h5", "h6",
        "li", "tr",
        "hr",
        "div", "section", "article", "blockquote", "pre",
        "table", "thead", "tbody", "tfoot", "ul", "ol",
    }
    # Tags whose children are themselves lines (recurse).
    RECURSE_INTO = {"div", "section", "article", "blockquote", "pre",
                    "table", "thead", "tbody", "tfoot", "ul", "ol"}

    def walk(node, d=0):
        if isinstance(node, NavigableString):
            text = str(node).strip()
            if text:
                depth[0] = d
                append_line(_escape_text(text))
            return
        if not isinstance(node, Tag):
            return
        name = (node.name or "").lower()
        if name == "br":
            return
        if name == "hr":
            append_line("<hr>")
            return
        if name in RECURSE_INTO:
            children = list(node.children)
            any_block = any(
                isinstance(c, Tag) and (c.name or "").lower() in BLOCK_LEVELS
                for c in children
            )
            if any_block:
                for c in children:
                    walk(c, d + 1)
            else:
                cleaned = _clean_block(node)
                if _line_visible_text(cleaned).strip():
                    depth[0] = d
                    append_line(cleaned)
            return
        # Treat any other block element (p, h1..h6, li, tr) as one line.
        if name in BLOCK_LEVELS:
            # Special case: <li> or <td> with nested lists — emit the text
            # part as one line, then recurse into children at deeper depth.
            if name in ("li", "td", "dd"):
                nested_lists = [c for c in node.children
                                if isinstance(c, Tag) and (c.name or "").lower() in ("ol", "ul", "dl")]
                if nested_lists:
                    # Emit the inline content before the first nested list
                    for c in node.children:
                        if isinstance(c, Tag) and (c.name or "").lower() in ("ol", "ul", "dl"):
                            break
                        if isinstance(c, NavigableString):
                            t = str(c).strip()
                            if t:
                                depth[0] = d
                                append_line(_escape_text(t))
                        elif isinstance(c, Tag):
                            cleaned = _clean_block(c)
                            if _line_visible_text(cleaned).strip():
                                depth[0] = d
                                append_line(cleaned)
                    # Recurse into nested lists at deeper depth
                    for nl in nested_lists:
                        walk(nl, d + 1)
                    return
            cleaned = _clean_block(node)
            if _line_visible_text(cleaned).strip():
                depth[0] = d
                append_line(cleaned)
            return
        # Inline tag at top — preserve as-is.
        text = node.get_text(" ", strip=True)
        if text:
            depth[0] = d
            append_line(_clean_block(node))

    body = soup.body or soup
    for child in list(body.children):
        walk(child)

    if not out:
        cleaned = _clean_block(soup)
        out.append((0, cleaned))
    html_to_lines._line_depths = _line_depths
    return out


def _escape_text(text: str) -> str:
    """Escape plain text for safe HTML display (no markup)."""
    return (
        text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
    )


def _clean_block(tag) -> str:
    """Return inner HTML for a block-level element with inline markup preserved.

    Removes ck-editor noise (data-* attributes, class="ck-..." on non-list
    elements) but keeps <strong>, <em>, <u>, <code>, <a>, <span> (limited).
    """
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return str(tag)

    # Strip all class/data attributes from non-essential tags.
    KEEP_ATTRS = {"href", "title", "target", "rel"}
    for el in tag.find_all(True):
        if el.name in {"strong", "em", "u", "code", "a"}:
            # Keep these inline tags; trim noisy attrs.
            if el.name != "a":
                el.attrs = {}
            else:
                el.attrs = {k: v for k, v in el.attrs.items() if k in KEEP_ATTRS}
            continue
        # For everything else, keep only essential attrs.
        el.attrs = {k: v for k, v in el.attrs.items() if k in KEEP_ATTRS}

    # Render inner HTML.
    inner = "".join(str(c) for c in tag.children)
    return inner.strip()


def diff_appended(current_content: str, snapshot_hash: Optional[str], snapshot_lines: int) -> Dict[str, Any]:
    """Lines added since the last snapshot. Returns:
        {
          "added_lines": [(global_index, inner_html), ...],
          "total_lines": N,
          "snapshot_match": bool,
          "line_depths": {line_index: depth, ...},
        }
    """
    lines = html_to_lines(current_content)
    depths = getattr(html_to_lines, "_line_depths", {})
    if snapshot_hash is None:
        baseline = max(0, len(lines) - 200)
        added = _split_nonblank(lines[baseline:])
        return {
            "added_lines": added,
            "total_lines": len(lines),
            "snapshot_match": True,
            "baseline_lines": baseline,
            "line_depths": depths,
        }

    plain = [_line_visible_text(html) for _, html in lines]
    current_hash = _hash_lines(plain[:snapshot_lines])
    added = _split_nonblank(lines[snapshot_lines:])
    return {
        "added_lines": added,
        "total_lines": len(lines),
        "snapshot_match": current_hash == snapshot_hash,
        "baseline_lines": snapshot_lines,
        "line_depths": depths,
    }


# ── Settings helpers ─────────────────────────────────────────────
def _get_class_cfg(settings: dict, class_id: str) -> dict:
    block = (settings.get("noteQuiz") or {}).get("classes") or {}
    return block.get(str(class_id)) or {}


def is_class_enabled(settings: dict, class_id: str) -> bool:
    cfg = _get_class_cfg(settings, class_id)
    return bool(cfg.get("enabled"))


def class_min_lines(settings: dict, class_id: str) -> int:
    cfg = _get_class_cfg(settings, class_id)
    try:
        return max(1, int(cfg.get("minLines") or 3))
    except Exception:
        return 3


def _parse_hhmm(value) -> Optional[tuple]:
    """Return (hour, minute) for 'HH:MM' or None if invalid."""
    if not value:
        return None
    s = str(value).strip()
    if ":" not in s:
        return None
    parts = s.split(":", 1)
    if len(parts) != 2:
        return None
    try:
        h = int(parts[0]); m = int(parts[1])
    except Exception:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return (h, m)


def class_end_time(settings: dict, class_id: str) -> Optional[tuple]:
    """End time as (hour, minute) or None if unset/invalid."""
    cfg = _get_class_cfg(settings, class_id)
    return _parse_hhmm(cfg.get("endTime"))


def class_start_time(settings: dict, class_id: str) -> Optional[tuple]:
    cfg = _get_class_cfg(settings, class_id)
    return _parse_hhmm(cfg.get("startTime"))


def class_weekdays(settings: dict, class_id: str) -> set:
    """Days of week (0=Mon..6=Sun) this class meets. Defaults to M-F."""
    cfg = _get_class_cfg(settings, class_id)
    raw = cfg.get("weekdays")
    if not isinstance(raw, list) or not raw:
        return {0, 1, 2, 3, 4}  # Mon-Fri default
    out = set()
    for v in raw:
        try:
            d = int(v)
        except Exception:
            continue
        if 0 <= d <= 6:
            out.add(d)
    return out or {0, 1, 2, 3, 4}


# ── Set persistence ──────────────────────────────────────────────
def latest_snapshot(class_id: str, chapter_note_id: str) -> Optional[sqlite3.Row]:
    init_db()
    with _lock, _conn() as c:
        return c.execute(
            "SELECT * FROM note_quiz_sets WHERE class_id=? AND chapter_note_id=? ORDER BY id DESC LIMIT 1",
            (str(class_id), str(chapter_note_id)),
        ).fetchone()


def save_set(class_id: str, class_name: str, chapter_note_id: str, chapter_title: str,
             source_lines: List[Tuple[int, str]], snapshot_lines: int, model: str,
             questions: List[dict], status: str = "ready", title: str = "",
             depths: dict = None) -> int:
    init_db()
    # Hash the visible text of the snapshot prefix so the snapshot is stable
    # across inline-HTML / whitespace edits that don't change the words.
    snapshot_text = [_line_visible_text(html) for _, html in source_lines]
    snapshot_hash = _hash_lines(snapshot_text)
    with _lock, _conn() as c:
        cur = c.execute(
            "INSERT INTO note_quiz_sets(class_id, class_name, chapter_note_id, chapter_title, title, snapshot_lines, snapshot_hash, source_lines_json, line_count, generated_at, generated_by_model, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                str(class_id),
                class_name or "",
                str(chapter_note_id),
                chapter_title or "",
                (title or "").strip()[:80],
                int(snapshot_lines),
                snapshot_hash,
                json.dumps([{"i": i, "t": t, "d": (depths or {}).get(i, 0)} for i, t in source_lines]),
                len(source_lines),
                _now_local(),
                model or "",
                status,
            ),
        )
        set_id = cur.lastrowid
        for q in questions:
            c.execute(
                "INSERT INTO note_quiz_questions(set_id, position, prompt, choices_json, correct_index, explanation, note_line_start, note_line_end, color_state) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    set_id,
                    int(q.get("position") or 0),
                    str(q.get("prompt") or "").strip(),
                    json.dumps(q.get("choices") or []),
                    int(q.get("correctIndex") or 0),
                    str(q.get("explanation") or "").strip(),
                    int(q.get("noteLineStart") or 0),
                    int(q.get("noteLineEnd") or q.get("noteLineStart") or 0),
                    "pending",
                ),
            )
        # Track line ranges for color escalation. Use distinct (start,end) pairs.
        seen = set()
        for q in questions:
            key = (int(q.get("noteLineStart") or 0), int(q.get("noteLineEnd") or q.get("noteLineStart") or 0))
            if key in seen:
                continue
            seen.add(key)
            c.execute(
                "INSERT INTO note_quiz_lines(set_id, line_start, line_end, color_state, attempts_wrong) VALUES (?,?,?,?,0)",
                (set_id, key[0], key[1], "pending"),
            )
    return set_id


def question_counts(set_ids) -> Dict[int, int]:
    """Return {set_id: question_count} for the given set ids."""
    ids = [int(i) for i in (set_ids or [])]
    if not ids:
        return {}
    init_db()
    with _lock, _conn() as c:
        marks = ",".join("?" * len(ids))
        rows = c.execute(
            f"SELECT set_id, COUNT(*) AS n FROM note_quiz_questions WHERE set_id IN ({marks}) GROUP BY set_id",
            ids,
        ).fetchall()
    return {int(r["set_id"]): int(r["n"]) for r in rows}


def list_sets(class_id: Optional[str] = None) -> List[dict]:
    init_db()
    with _lock, _conn() as c:
        if class_id:
            rows = c.execute("SELECT * FROM note_quiz_sets WHERE class_id=? ORDER BY id DESC", (str(class_id),)).fetchall()
        else:
            rows = c.execute("SELECT * FROM note_quiz_sets ORDER BY id DESC LIMIT 200").fetchall()
    out = [dict(r) for r in rows]
    counts = question_counts([r["id"] for r in out])
    for r in out:
        r["questionCount"] = counts.get(r["id"], 0)
    return out


def get_set(set_id: int) -> Optional[dict]:
    init_db()
    with _lock, _conn() as c:
        s = c.execute("SELECT * FROM note_quiz_sets WHERE id=?", (int(set_id),)).fetchone()
        if not s:
            return None
        qs = c.execute("SELECT * FROM note_quiz_questions WHERE set_id=? ORDER BY position", (int(set_id),)).fetchall()
        ls = c.execute("SELECT * FROM note_quiz_lines WHERE set_id=? ORDER BY line_start", (int(set_id),)).fetchall()
    out = dict(s)
    # Normalize to camelCase for the API.
    out["classId"] = out.pop("class_id")
    out["chapterNoteId"] = out.pop("chapter_note_id")
    out["chapterTitle"] = out.pop("chapter_title")
    out["snapshotLines"] = out.pop("snapshot_lines")
    out["generatedAt"] = out.pop("generated_at")
    out["generatedByModel"] = out.pop("generated_by_model")
    out["lineCount"] = out.pop("line_count")
    out["firstTryPct"] = out.pop("first_try_pct", None)
    out["questions"] = [
        {
            "id": int(q["id"]),
            "setId": int(q["set_id"]),
            "position": int(q["position"]),
            "prompt": q["prompt"],
            "choices": json.loads(q["choices_json"] or "[]"),
            "correctIndex": int(q["correct_index"]),
            "explanation": q["explanation"],
            "noteLineStart": int(q["note_line_start"]),
            "noteLineEnd": int(q["note_line_end"]),
            "colorState": q["color_state"],
        }
        for q in qs
    ]
    out["lines"] = [
        {
            "id": int(l["id"]),
            "setId": int(l["set_id"]),
            "lineStart": int(l["line_start"]),
            "lineEnd": int(l["line_end"]),
            "colorState": l["color_state"],
            "attemptsWrong": int(l["attempts_wrong"]),
        }
        for l in ls
    ]
    out["sourceLines"] = json.loads(out.pop("source_lines_json") or "[]")
    out.pop("snapshot_hash", None)
    return out


def delete_set(set_id: int) -> None:
    """Delete a note quiz set and cascade-delete its questions, lines, and attempts."""
    init_db()
    with _lock, _conn() as c:
        c.execute("DELETE FROM note_quiz_attempts WHERE set_id=?", (int(set_id),))
        c.execute("DELETE FROM note_quiz_lines WHERE set_id=?", (int(set_id),))
        c.execute("DELETE FROM note_quiz_questions WHERE set_id=?", (int(set_id),))
        c.execute("DELETE FROM note_quiz_sets WHERE id=?", (int(set_id),))


# ── Attempts + line color escalation ─────────────────────────────
_VALID_COLORS = {"pending", "green", "red", "yellow", "bright_red"}


def _next_color(current: str, was_wrong: bool) -> str:
    """Per-line escalation. Mastery = green. Once green, never relapses."""
    if not was_wrong:
        if current in ("pending", "green"):
            return "green"
        if current == "red":
            return "yellow"        # recovered: was wrong, now correct
        if current == "yellow":
            return "yellow"        # already recovered; stays
        if current == "bright_red":
            return "yellow"        # recovered from worst
        return "green"
    # was wrong
    if current == "pending":
        return "red"
    if current == "red":
        return "bright_red"        # wrong again after already red
    if current == "yellow":
        return "red"               # relapse: was yellow, wrong again
    if current == "bright_red":
        return "bright_red"        # stays at worst
    if current == "green":
        return "red"               # never happens in practice; defensive
    return "red"


def record_attempt(set_id: int, answers: Dict[int, int], duration_seconds: Optional[float] = None) -> dict:
    """answers: {question_id: chosen_index}. Returns the attempt summary."""
    init_db()
    with _lock, _conn() as c:
        qs = c.execute("SELECT * FROM note_quiz_questions WHERE set_id=? ORDER BY position", (int(set_id),)).fetchall()
        if not qs:
            return {"setId": set_id, "score": 0, "total": 0, "missedQuestionIds": [], "lineOutcomes": []}
        missed_ids = []
        line_outcomes = []  # [{lineStart, lineEnd, colorAfter, wasWrong}]
        score = 0
        total = len(qs)
        for q in qs:
            chosen = answers.get(int(q["id"]))
            correct = chosen is not None and int(chosen) == int(q["correct_index"])
            if correct:
                score += 1
            else:
                missed_ids.append(int(q["id"]))
            # Update question color_state.
            prev_q = q["color_state"]
            new_q = _next_color(prev_q, not correct)
            c.execute("UPDATE note_quiz_questions SET color_state=? WHERE id=?", (new_q, int(q["id"])))
            # Update line color for this question's line range.
            line_row = c.execute(
                "SELECT * FROM note_quiz_lines WHERE set_id=? AND line_start=? AND line_end=?",
                (int(set_id), int(q["note_line_start"]), int(q["note_line_end"])),
            ).fetchone()
            if line_row:
                new_line = _next_color(line_row["color_state"], not correct)
                wrong_count = line_row["attempts_wrong"] + (0 if correct else 1)
                c.execute(
                    "UPDATE note_quiz_lines SET color_state=?, attempts_wrong=? WHERE id=?",
                    (new_line, wrong_count, int(line_row["id"])),
                )
                line_outcomes.append({
                    "lineStart": int(q["note_line_start"]),
                    "lineEnd": int(q["note_line_end"]),
                    "colorAfter": new_line,
                    "wasWrong": not correct,
                })
        cur = c.execute(
            "INSERT INTO note_quiz_attempts(set_id, started_at, finished_at, score, total, missed_question_ids_json, line_outcomes_json) VALUES (?,?,?,?,?,?,?)",
            (
                int(set_id),
                _now_local(),
                _now_local(),
                int(score),
                int(total),
                json.dumps(missed_ids),
                json.dumps(line_outcomes),
            ),
        )
        attempt_id = cur.lastrowid
        # Persist the first-try percent on the set (only the very first attempt).
        prior = c.execute("SELECT COUNT(*) c FROM note_quiz_attempts WHERE set_id=?", (int(set_id),)).fetchone()["c"]
        if prior == 1 and total > 0:
            c.execute(
                "UPDATE note_quiz_sets SET first_try_pct=? WHERE id=?",
                (round(score * 100.0 / total, 1), int(set_id)),
            )
    return {
        "attemptId": attempt_id,
        "setId": set_id,
        "score": score,
        "total": total,
        "missedQuestionIds": missed_ids,
        "lineOutcomes": line_outcomes,
        "durationSeconds": duration_seconds,
    }


def missed_questions_summary(set_id: int) -> dict:
    """Returns counts of lines currently in red/bright_red for the missed-banner."""
    init_db()
    with _lock, _conn() as c:
        s = c.execute("SELECT * FROM note_quiz_sets WHERE id=?", (int(set_id),)).fetchone()
        if not s:
            return {"redCount": 0, "yellowCount": 0, "greenCount": 0, "anyRed": False}
        rows = c.execute("SELECT color_state, COUNT(*) c FROM note_quiz_lines WHERE set_id=? GROUP BY color_state", (int(set_id),)).fetchall()
        counts = {r["color_state"]: r["c"] for r in rows}
    return {
        "redCount": counts.get("red", 0) + counts.get("bright_red", 0),
        "yellowCount": counts.get("yellow", 0),
        "greenCount": counts.get("green", 0),
        "anyRed": (counts.get("red", 0) + counts.get("bright_red", 0)) > 0,
    }


def calendar_status(year: int, month: int) -> dict:
    """Returns per-day status for the calendar: count of sets, completion, last attempt."""
    init_db()
    month_prefix = f"{year:04d}-{month:02d}"
    with _lock, _conn() as c:
        sets = c.execute(
            "SELECT id, class_id, class_name, chapter_title, generated_at, status, first_try_pct FROM note_quiz_sets WHERE substr(generated_at,1,7)=? ORDER BY generated_at",
            (month_prefix,),
        ).fetchall()
        attempts = c.execute(
            "SELECT set_id, finished_at, score, total FROM note_quiz_attempts WHERE substr(finished_at,1,7)=? ORDER BY finished_at",
            (month_prefix,),
        ).fetchall()
    by_day = {}
    for s in sets:
        d = (s["generated_at"] or "")[:10]
        if not d:
            continue
        bucket = by_day.setdefault(d, {"date": d, "setCount": 0, "attemptCount": 0, "totalQuestions": 0, "correctAnswers": 0, "anyRed": False, "sets": [], "classes": []})
        bucket["setCount"] += 1
        bucket["sets"].append({
            "id": s["id"],
            "classId": s["class_id"],
            "className": s["class_name"],
            "chapterTitle": s["chapter_title"],
            "generatedAt": s["generated_at"],
            "firstTryPct": s["first_try_pct"],
        })
    for a in attempts:
        d = (a["finished_at"] or "")[:10]
        if not d:
            continue
        bucket = by_day.get(d)
        if not bucket:
            continue
        bucket["attemptCount"] += 1
        bucket["totalQuestions"] += int(a["total"] or 0)
        bucket["correctAnswers"] += int(a["score"] or 0)
    # Compute per-day color status from the latest line states.
    with _lock, _conn() as c:
        for d, bucket in by_day.items():
            reds = 0
            yellows = 0
            greens = 0
            # Per-class rollup (for class-color bars + accuracy circles on cells).
            by_cls = {}
            for s in bucket["sets"]:
                cls_key = str(s["classId"])
                row = by_cls.setdefault(cls_key, {"classId": s["classId"], "className": s["className"] or cls_key, "setCount": 0, "firstTryPcts": []})
                row["setCount"] += 1
                if s["firstTryPct"] is not None:
                    row["firstTryPcts"].append(float(s["firstTryPct"]))
                lines = c.execute("SELECT color_state, COUNT(*) c FROM note_quiz_lines WHERE set_id=? GROUP BY color_state", (s["id"],)).fetchall()
                for r in lines:
                    if r["color_state"] in ("red", "bright_red"):
                        reds += r["c"]
                    elif r["color_state"] == "yellow":
                        yellows += r["c"]
                    elif r["color_state"] == "green":
                        greens += r["c"]
            bucket["classes"] = [
                {
                    "classId": row["classId"],
                    "className": row["className"],
                    "setCount": row["setCount"],
                    "firstTryPct": round(sum(row["firstTryPcts"]) / len(row["firstTryPcts"]), 1) if row["firstTryPcts"] else None,
                }
                for row in by_cls.values()
            ]
            if reds > 0:
                bucket["status"] = "red"
                bucket["anyRed"] = True
            elif yellows > 0:
                bucket["status"] = "yellow"
            elif greens > 0 and bucket["attemptCount"] > 0:
                bucket["status"] = "green"
            else:
                bucket["status"] = "pending" if bucket["setCount"] > 0 else "none"
            bucket["redCount"] = reds
            bucket["yellowCount"] = yellows
            bucket["greenCount"] = greens
            bucket["completionPct"] = (bucket["correctAnswers"] * 100 // bucket["totalQuestions"]) if bucket["totalQuestions"] else 0
            # Drop internal sets list to keep payload small (calendar only needs counts).
            bucket.pop("sets", None)
    return {"year": int(year), "month": int(month), "days": list(by_day.values())}


def dashboard_stats(class_id: Optional[str] = None) -> dict:
    """Today's count + streak + per-class mini-streak bars."""
    init_db()
    today = datetime.now().strftime("%Y-%m-%d")
    with _lock, _conn() as c:
        today_sets = c.execute(
            "SELECT COUNT(*) c FROM note_quiz_sets WHERE substr(generated_at,1,10)=?",
            (today,),
        ).fetchone()["c"]
        if class_id:
            cls_sets = c.execute(
                "SELECT generated_at FROM note_quiz_sets WHERE class_id=? ORDER BY id DESC",
                (str(class_id),),
            ).fetchall()
        else:
            cls_sets = c.execute(
                "SELECT generated_at, class_id FROM note_quiz_sets ORDER BY id DESC LIMIT 500"
            ).fetchall()
    # Streak: consecutive days with at least one finished attempt (no missed-yellow pending).
    finished = []
    with _lock, _conn() as c:
        rows = c.execute("SELECT substr(finished_at,1,10) d FROM note_quiz_attempts ORDER BY finished_at DESC LIMIT 365").fetchall()
    seen = []
    for r in rows:
        if r["d"] and (not seen or seen[-1] != r["d"]):
            seen.append(r["d"])
    streak = 0
    if seen:
        from datetime import date, timedelta
        today_d = date.today()
        cur = today_d
        for d in seen:
            try:
                dd = date.fromisoformat(d)
            except Exception:
                continue
            if dd == cur:
                streak += 1
                cur = cur - timedelta(days=1)
            elif dd == cur + timedelta(days=1) and streak == 0:
                # allow yesterday if nothing today
                cur = dd
                streak += 1
                cur = cur - timedelta(days=1)
            else:
                break
    # Per-class mini-streak: consecutive days with at least one set for that class.
    per_class = {}
    if cls_sets:
        from collections import defaultdict
        by_class = defaultdict(set)
        for r in cls_sets:
            d = (r["generated_at"] or "")[:10]
            if d:
                by_class[r["class_id"] if "class_id" in r.keys() else ""].add(d)
        # (class_id, class_name) by querying names
        with _lock, _conn() as c:
            name_rows = c.execute("SELECT class_id, class_name FROM note_quiz_sets GROUP BY class_id").fetchall()
        names = {r["class_id"]: r["class_name"] for r in name_rows}
        from datetime import date, timedelta
        today_d = date.today()
        for cid, days in by_class.items():
            cur = today_d
            ms = 0
            while cur.isoformat() in days:
                ms += 1
                cur = cur - timedelta(days=1)
            # If no quiz today yet, check if yesterday's quiz keeps streak alive
            if ms == 0 and (today_d - timedelta(days=1)).isoformat() in days:
                cur = today_d - timedelta(days=1)
                ms = 1
                while cur.isoformat() in days:
                    ms += 1
                    cur = cur - timedelta(days=1)
            per_class[cid] = {"classId": cid, "className": names.get(cid, cid), "streak": ms}
    return {"todayCount": int(today_sets), "streak": int(streak), "perClass": per_class}


# ── AI generation ────────────────────────────────────────────────
from prompts import get_prompt as _get_prompt


def _has_bold(html: str) -> bool:
    """Heuristic: does this line contain an inline emphasis marker (strong/b)?."""
    if not html:
        return False
    low = html.lower()
    return "<strong>" in low or "<b>" in low or "<em>" in low or "<i>" in low


def _number_lines(lines: List[Tuple[int, str]], depths: dict = None) -> str:
    out = []
    for i, t in lines:
        d = (depths or {}).get(i, 0)
        clean = _line_visible_text(t)
        indent = "  " * d
        out.append(f"{i+1:>4} | {indent}{clean}")
    return "\n".join(out)


# Stopwords ignored when matching a prompt to its supporting line.
_STOPWORDS = {
    "about", "after", "again", "also", "before", "between", "does", "from",
    "have", "into", "than", "that", "their", "there", "these", "this",
    "those", "which", "while", "with", "what", "where", "when", "whose",
    "your", "would", "could", "should", "which", "every", "other", "some",
    "each", "them", "they", "then", "over", "under", "because", "based",
}


def _best_line(prompt: str, notes: List[Tuple[int, str]]) -> int:
    """Pick the 1-based note line whose text best matches the prompt's keywords.

    Used as a fallback when the AI's line references are missing or out of
    range, so every question still highlights a sensible line.
    """
    words = {w for w in re.findall(r"[a-z]{4,}", (prompt or "").lower()) if w not in _STOPWORDS}
    if not words:
        return 1
    best_idx, best_score = 1, 0
    for i, (_, html) in enumerate(notes):
        text = _line_visible_text(html).lower()
        score = sum(1 for w in words if w in text)
        if score > best_score:
            best_idx, best_score = i + 1, score
    return best_idx


def _parse_strict_json(text: str) -> Optional[dict]:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        return None


def _build_simple_prompt(notes_block: str, settings: dict) -> str:
    """Build the user prompt for Ollama. Pulled from settings.prompts.note_quiz_user
    if the user has overridden it; otherwise the default. The placeholder
    {notes_block} is substituted with the numbered notes."""
    template = _get_prompt(settings, "note_quiz_user")
    if "{notes_block}" in template:
        return template.replace("{notes_block}", notes_block)
    # Default fallback if the override lost the placeholder.
    return template + "\n\nNotes (line-numbered, 1-based):\n" + notes_block + "\n"


_QUESTION_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_questions",
        "description": "Submit the multiple-choice quiz questions you wrote from the student's notes.",
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short name for the set. If the notes have a chapter/section label (like '14.2', 'Section 3.1', 'Chapter 5'), lead with it, then the main topic in AT MOST 3 words. Examples: '14.2 Photosynthesis', 'Ch 5 Cellular Respiration'. Under 40 characters."},
                "questions": {
                    "type": "array",
                    "description": "One object per question. Every question must reference REAL line numbers (1-based) printed in the notes; never invent line numbers.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "prompt": {"type": "string", "description": "Question sentence ending in '?'"},
                            "choices": {"type": "array", "items": {"type": "string"}, "minItems": 4, "maxItems": 4, "description": "Exactly 4 choices; exactly one is correct"},
                            "correctIndex": {"type": "integer", "minimum": 0, "maximum": 3, "description": "Index of the correct choice in choices"},
                            "explanation": {"type": "string", "description": "One short sentence explaining the answer"},
                            "noteLineStart": {"type": "integer", "minimum": 1, "description": "First supporting line number in the notes"},
                            "noteLineEnd": {"type": "integer", "minimum": 1, "description": "Last supporting line number in the notes"},
                        },
                        "required": ["prompt", "choices", "correctIndex", "explanation", "noteLineStart", "noteLineEnd"],
                    },
                }
            },
            "required": ["title", "questions"],
        },
    },
}


def _message_questions(message: dict) -> Optional[dict]:
    """Pull the quiz payload out of an assistant message.

    Prefers the submit_questions tool call (Ollama validates arguments against
    the schema), then falls back to parsing JSON from the message content or
    reasoning text, so models that answer in prose instead of calling the tool
    still work.
    """
    for call in (message.get("tool_calls") or []):
        if ((call.get("function") or {}).get("name")) == "submit_questions":
            args = (call.get("function") or {}).get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    continue
            if isinstance(args, dict):
                return args
    for field in ("content", "reasoning_content"):
        parsed = _parse_strict_json(message.get(field) or "")
        if parsed and isinstance(parsed.get("questions"), list):
            return parsed
    for field in ("content", "reasoning_content"):
        parsed = _extract_json_block(message.get(field) or "")
        if parsed and isinstance(parsed.get("questions"), list):
            return parsed
    return None


def _extract_json_block(text: str) -> Optional[dict]:
    """Lenient fallback: pull the first { ... } object out of surrounding prose."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except Exception:
        return None


def generate_questions(notes: List[Tuple[int, str]], settings: dict, clarification: str = None, depths: dict = None) -> List[dict]:
    """Send numbered notes to Ollama and let it author questions freely.

    The AI decides how many questions to produce based on the content. We
    enforce: a real prompt, exactly 4 choices with a valid correctIndex, and
    usable line references. References are stored as 0-based positions
    matching the frontend's sourceLines array.
    """
    if not notes:
        return []
    key = (settings.get("apiKeys") or {}).get("ollama")
    if not key:
        raise ValueError("Ollama API key is missing in Settings.")
    model = (settings.get("ollamaModel") or "gpt-oss:120b").strip() or "gpt-oss:120b"
    notes_block = _number_lines(notes, depths)
    system_prompt = _get_prompt(settings, "note_quiz_generate")
    user_prompt = _build_simple_prompt(notes_block, settings)
    if clarification:
        user_prompt += f"\n\nAdditional instructions from the teacher:\n{clarification}\n"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "tools": [_QUESTION_TOOL],
        "tool_choice": "submit_questions",
    }
    try:
        message = _ollama_request_message(payload, key)
    except Exception as exc:
        raise RuntimeError(f"AI request failed: {exc}") from exc
    parsed = _message_questions(message)
    if not parsed or not isinstance(parsed.get("questions"), list):
        raise RuntimeError("AI did not return valid questions.")
    out: List[dict] = []
    max_index = len(notes)

    def _pos(v) -> Optional[int]:
        """1-based line position in the numbered notes, or None if invalid."""
        try:
            p = int(v)
        except Exception:
            return None
        return p if 1 <= p <= max_index else None

    for pos, q in enumerate(parsed["questions"]):
        try:
            prompt = str(q.get("prompt") or "").strip()
            choices = [str(c).strip() for c in (q.get("choices") or []) if str(c).strip()]
            if len(prompt) < 5 or len(choices) != 4:
                continue
            ci = int(q.get("correctIndex") or 0)
            if ci < 0 or ci >= len(choices):
                continue
            ls = _pos(q.get("noteLineStart"))
            le = _pos(q.get("noteLineEnd"))
            if ls is None or le is None:
                # AI gave no usable line reference: fall back to the line whose
                # text best matches the prompt so highlighting still works.
                ls = le = _best_line(prompt, notes)
            if le < ls:
                ls, le = le, ls
            # Store 0-based positions (index into sourceLines) to match the
            # frontend's split-view line rendering.
            out.append({
                "position": pos,
                "prompt": prompt,
                "choices": choices,
                "correctIndex": ci,
                "explanation": str(q.get("explanation") or "").strip(),
                "noteLineStart": ls - 1,
                "noteLineEnd": le - 1,
            })
        except Exception:
            continue
    if not out:
        raise RuntimeError("AI returned no usable questions.")
    title = str(parsed.get("title") or "").strip()
    if not title:
        # Fall back to the first line that looks like a section label, if any.
        title = _guess_section_title(notes)
    return {"questions": out, "title": title[:80]}


def _guess_section_title(notes: List[Tuple[int, str]]) -> str:
    """Best-effort title when the AI doesn't return one: prefer a heading-ish
    line (chapter/section label like '14.2', or a short heading) near the top
    of the new notes."""
    best = ""
    for _, html in notes[:12]:
        text = _line_visible_text(html).strip()
        if not text:
            continue
        plain = re.sub(r"<[^>]+>", "", html).strip()
        lowered = plain.lower()
        if re.search(r"\b(chapter|section|lesson|unit)\b", lowered) or re.search(r"\b\d+\.\d+\b", plain):
            best = plain[:80]
            break
        if len(plain) <= 60 and not lowered.endswith((".", ":")) and best == "":
            best = plain[:80]
    return best
