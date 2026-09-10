"""One-shot per-class scheduler for note quizzes.

Each enabled class with a valid endTime and weekday mask gets one timer that
fires at endTime on each matching weekday. On fire it calls the same code path
the /api/note_quiz/sets/generate endpoint uses. If there's no diff or Trilium
is unreachable, it stays silent (logs only). Errors are caught and logged.

rebuild() should be called at startup and after settings change.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta
from typing import Optional

from trilium_client import TriliumError, get_class_note, get_note_content, latest_chapter

import note_quiz


log = logging.getLogger("note_quiz_scheduler")
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(levelname)s %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)


_lock = threading.RLock()
_timers: list[threading.Timer] = []
_last_rebuild_at: Optional[datetime] = None
_last_fired: dict[str, datetime] = {}  # class_id -> last fire time (avoid double-fire)


def _class_end_time_now(settings, class_id):
    """Return next datetime the class fires, or None if no valid schedule."""
    end = note_quiz.class_end_time(settings, class_id)
    if not end:
        return None
    weekdays = note_quiz.class_weekdays(settings, class_id)
    if not weekdays:
        return None
    h, m = end
    now = datetime.now()
    # Monday=0 in our schema. Walk up to 7 days forward to find the next matching day.
    # If today matches and we haven't passed endTime yet, fire today.
    for offset in range(0, 8):
        candidate_day = now + timedelta(days=offset)
        py_weekday = candidate_day.weekday()  # Mon=0..Sun=6 — matches our schema
        if py_weekday not in weekdays:
            continue
        fire_at = candidate_day.replace(hour=h, minute=m, second=0, microsecond=0)
        if fire_at > now:
            return fire_at
    return None


def _fire(class_id: str):
    """Run the generation flow for one class. Catches everything."""
    try:
        settings = note_quiz_module_settings()
        if not note_quiz.is_class_enabled(settings, class_id):
            return
        # Throttle: don't re-fire the same class within 30 seconds.
        last = _last_fired.get(class_id)
        if last and (datetime.now() - last).total_seconds() < 30:
            return
        _last_fired[class_id] = datetime.now()
        class_name = ""

        link = get_class_note(class_id, settings)
        if not link:
            log.info("scheduler: class %s has no linked Trilium folder, skipping", class_id)
            return
        chapter = None
        try:
            chapter = latest_chapter(link["noteId"], settings)
        except TriliumError as exc:
            log.info("scheduler: Trilium error fetching chapter for %s: %s", class_id, exc)
            return
        if not chapter:
            log.info("scheduler: no chapter for class %s, skipping", class_id)
            return
        chapter_note_id = chapter["noteId"]
        try:
            content = get_note_content(chapter_note_id, settings)
        except TriliumError as exc:
            log.info("scheduler: Trilium error reading content for %s: %s", class_id, exc)
            return
        snapshot = note_quiz.latest_snapshot(class_id, chapter_note_id)
        diff = note_quiz.diff_appended(
            content,
            snapshot["snapshot_hash"] if snapshot else None,
            int(snapshot["snapshot_lines"]) if snapshot else 0,
        )
        min_lines = note_quiz.class_min_lines(settings, class_id)
        if len(diff["added_lines"]) < min_lines:
            log.info(
                "scheduler: class %s has %d new lines (need %d), skipping",
                class_id, len(diff["added_lines"]), min_lines,
            )
            return
        try:
            generated = note_quiz.generate_questions(diff["added_lines"], settings)
            questions = generated["questions"]
            set_title = generated.get("title") or ""
        except ValueError as exc:
            log.error("scheduler: %s for class %s", exc, class_id)
            _report_error(class_id, class_name or class_id, "Note quiz generation skipped", str(exc))
            return
        except RuntimeError as exc:
            log.error("scheduler: AI generation failed for class %s: %s", class_id, exc)
            _report_error(class_id, class_name or class_id, "AI generation failed", str(exc))
            return
        try:
            from dashboard_server import _computed_payload
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
        )
        log.info(
            "scheduler: generated note quiz set %d for %s (%d questions from %d new lines)",
            set_id, class_name or class_id, len(questions), len(diff["added_lines"]),
        )
        # Notify (best-effort). Errors here must not crash the timer.
        _notify_success(class_id, class_name, set_id, len(questions))
    except Exception as exc:  # last-resort: never let a timer die silently
        log.exception("scheduler: unhandled error firing class %s: %s", class_id, exc)
        _report_error(class_id, class_id, "Scheduler crash", str(exc))


def _report_error(class_id: str, class_name: str, label: str, message: str) -> None:
    """Send a 'errors'-scope email + log. Safe to call from any code path."""
    try:
        from grades_emailer import send_error_email_to_scope
        subject = f"GradeTrack: {label} ({class_name})"
        ok = send_error_email_to_scope(subject, message, logs=f"class_id={class_id}", details=None)
        if ok:
            log.info("scheduler: error email sent for %s", class_id)
    except Exception as exc:
        log.warning("scheduler: error email send failed: %s", exc)


def _notify_success(class_id: str, class_name: str, set_id: int, qcount: int) -> None:
    """Hook for future toast + browser notification. For now just log."""
    # Browser notification + toast happen client-side; the server can only log here.
    # The frontend polls /api/note_quiz/today to discover new sets and shows the toast itself.
    log.info("scheduler: notify available: set=%d class=%s questions=%d", set_id, class_name, qcount)


def _schedule_one(class_id: str, fire_at: datetime) -> None:
    delay = max(0.5, (fire_at - datetime.now()).total_seconds())
    t = threading.Timer(delay, _fire, args=(class_id,))
    t.daemon = True
    t.name = f"note-quiz-{class_id}-{fire_at.isoformat()}"
    t.start()
    _timers.append(t)


def note_quiz_module_settings():
    """Lazy import to avoid a circular import at module load."""
    from dashboard_server import load_settings
    return load_settings()


def rebuild() -> None:
    """Cancel all current timers and schedule new ones from current settings."""
    global _last_rebuild_at
    with _lock:
        for t in _timers:
            try:
                t.cancel()
            except Exception:
                pass
        _timers.clear()

        settings = note_quiz_module_settings()
        classes = (settings.get("noteQuiz") or {}).get("classes") or {}
        scheduled = 0
        for cid in list(classes.keys()):
            if not note_quiz.is_class_enabled(settings, cid):
                continue
            fire_at = _class_end_time_now(settings, cid)
            if not fire_at:
                continue
            try:
                _schedule_one(cid, fire_at)
                scheduled += 1
            except Exception as exc:
                log.warning("scheduler: could not schedule %s: %s", cid, exc)
        _last_rebuild_at = datetime.now()
        log.info("scheduler: rebuild complete, %d timer(s) scheduled", scheduled)


def status() -> dict:
    """Diagnostic snapshot for /api/note_quiz/scheduler/status."""
    with _lock:
        return {
            "activeTimers": len(_timers),
            "lastRebuildAt": _last_rebuild_at.isoformat() if _last_rebuild_at else None,
            "lastFired": {k: v.isoformat() for k, v in _last_fired.items()},
        }
