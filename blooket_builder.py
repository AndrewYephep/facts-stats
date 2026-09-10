"""Blooket Quiz Builder for GradeTrack.

Takes a class's linked Trilium notes folder, finds its latest chapter, asks the
Ollama Cloud model to write a multiple-choice review quiz (optionally guided by
a short focus prompt), converts the returned questions into Blooket's import
CSV format, then drives the blooket-bot (nodriver/Chromium) to publish the set
and reports its shareable URL.

Runs as a single background job at a time; dashboard_server.py exposes
/ api/blooket/* routes that read job status from this module.
"""

import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from grades_config import load_settings
from trilium_client import TriliumError, get_class_note, get_note_content, latest_chapter
from prompts import get_prompt as _get_prompt

OLLAMA_CHAT_URL = "https://ollama.com/api/chat"
DEFAULT_MODEL = "gpt-oss:120b"
OLLAMA_TIMEOUT = 240

# Native path on the Raspberry Pi; override via env for local testing.
BLOOKET_DIR = os.environ.get("BLOOKET_DIR") or "/home/ahepworth/blooket-bot"
BLOOKET_SETS_DIR = os.path.join(BLOOKET_DIR, "sets")
BLOOKET_SETS_PATH = os.path.join(os.path.dirname(__file__), "data", "blooket_sets.json")

BLOOKET_SYSTEM_PROMPT = """Convert the user's notes into multiple choice quiz questions formatted for Blooket import.

OUTPUT FORMAT — follow this exactly:
Line 1: TITLE: <short review title drawn from the material>
Line 2: DESCRIPTION: <one sentence describing what this quiz covers>
Lines 3+: ONE CSV question per line, 7 comma-separated fields each:
 Question Text, Answer 1, Answer 2, Answer 3, Answer 4, Correct Answer Number (1-4), Time in seconds

STRICT RULES — your entire response must be plain text in the format above:
- Do NOT output JSON, XML, markdown code blocks, or any other structured format
- Do NOT include a header row
- Do NOT wrap fields or lines in quotes
- Do NOT use commas within questions or answers — use semicolons instead
- Do NOT include explanations, commentary, or anything outside the TITLE/DESCRIPTION/CSV lines
- The correct answer is a NUMBER (1-4), not text
- Use 20 for all time limits

EXAMPLE OUTPUT:
TITLE: Early Roman Culture Review
DESCRIPTION: Multiple choice review of early Roman cultural influences.
Which civilization influenced early Roman culture?,Greeks,Egyptians,Persians,Chinese,1,20
What material did Romans use for aqueducts?,Concrete,Wood,Stone,Iron,3,20
Which language did early Romans adopt from neighbors?,Latin,Greek,Etruscan,Samnite,3,20

Generate as many quality questions as the source material allows. Focus on creating great questions with quality options, and making a comprehensive (and in most cases exhaustive) quiz set."""

# Backward-compat: keep the constant name available if anything imports it,
# but always route through the prompts registry so the user can override it
# in Settings → AI tab.
def _blooket_system_prompt(settings):
    return _get_prompt(settings, "blooket_system") or BLOOKET_SYSTEM_PROMPT


# ── Job state (single worker at a time) ─────────────────────────
BLOOKET_JOB = {
    "process": None,
    "logs": [],
    "exitCode": None,
    "phase": "idle",  # idle | generating | publishing | done | failed
    "status": "",     # human-readable current step (e.g. "Entering title")
    "result": {},
    "jobId": None,
}
_BLOOKET_LOCK = threading.Lock()
_QUEUE = []  # list of pending {spec:, id:} jobs to run after the current one


def _new_job_id():
    return uuid.uuid4().hex[:8]


def queue_status():
    with _BLOOKET_LOCK:
        return {
            "queue": [{"id": j["id"], "label": j.get("label") or "", "meta": j.get("meta") or {}} for j in _QUEUE],
        }


def enqueue(spec):
    """Append a job to the wait queue. Returns the queue entry id."""
    with _BLOOKET_LOCK:
        jid = _new_job_id()
        _QUEUE.append({"id": jid, "spec": spec, "label": spec.get("label", ""), "meta": spec.get("meta", {})})
        return jid


def cancel_queued(job_id):
    """Remove a queued (not yet running) job by id. Returns True if removed."""
    with _BLOOKET_LOCK:
        for i, j in enumerate(_QUEUE):
            if j["id"] == job_id:
                del _QUEUE[i]
                return True
        # If it's the running job id, signal a stop request
        if BLOOKET_JOB.get("jobId") == job_id:
            BLOOKET_JOB["cancelRequested"] = True
            return True
    return False


def cancel_requested():
    with _BLOOKET_LOCK:
        return bool(BLOOKET_JOB.get("cancelRequested"))


def _clear_cancel():
    with _BLOOKET_LOCK:
        BLOOKET_JOB["cancelRequested"] = False


def job_status():
    with _BLOOKET_LOCK:
        process = BLOOKET_JOB["process"]
        running = bool(process and process.poll() is None) or BLOOKET_JOB["phase"] == "generating"
        q = [{"id": j["id"], "label": j.get("label") or "", "meta": j.get("meta") or {}} for j in _QUEUE]
        return {
            "running": running,
            "phase": BLOOKET_JOB["phase"],
            "status": BLOOKET_JOB["status"],
            "exitCode": BLOOKET_JOB["exitCode"],
            "logs": list(BLOOKET_JOB["logs"]),
            "result": dict(BLOOKET_JOB["result"] or {}),
            "jobId": BLOOKET_JOB.get("jobId"),
            "queued": len(q),
            "queue": q,
            "cancelRequested": bool(BLOOKET_JOB.get("cancelRequested")),
        }


# ── Saved set links (per class, keyed by source chapter note) ─
def load_saved_sets():
    """class_id -> {sourceNoteId: {setUrl, sourceNoteId, title, questionCount, chapterTitle, createdAt}}"""
    try:
        with open(BLOOKET_SETS_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    migrated = False
    for class_id, entry in list(data.items()):
        if isinstance(entry, dict) and "sourceNoteId" in entry:
            data[class_id] = {entry["sourceNoteId"]: entry}
            migrated = True
    if migrated:
        tmp = BLOOKET_SETS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
        os.replace(tmp, BLOOKET_SETS_PATH)
    return data


def save_saved_set(class_id, info):
    """Append a new set entry under a unique key so repeat runs for the same
    chapter note accumulate instead of overwriting the previous link.
    Returns the storage key so callers can reference the local set even before
    a Blooket URL exists (e.g. if publish fails)."""
    data = load_saved_sets()
    source = info.get("sourceNoteId") or "custom"
    key = f"{source}__{uuid.uuid4().hex[:8]}"
    data.setdefault(str(class_id), {})[key] = info
    _write_sets(data)
    return key


def _write_sets(data):
    os.makedirs(os.path.dirname(BLOOKET_SETS_PATH), exist_ok=True)
    tmp = BLOOKET_SETS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    os.replace(tmp, BLOOKET_SETS_PATH)


def _persist_generated_set(class_id, generated, persist=True, set_url=None):
    """Save a generated set locally the moment Ollama has produced questions,
    BEFORE the blooket bot runs. Keeps the questions (and partial data) even if
    the bot later fails or stalls. Returns the saved info (with a stable localKey
    string) so callers can open/review the local set without a Blooket URL."""
    info = {
        "setUrl": set_url or generated.get("setUrl") or "",
        "sourceNoteId": generated.get("sourceNoteId") or "",
        "title": generated.get("title") or "",
        "description": generated.get("description") or "",
        "questionCount": generated.get("questionCount") or 0,
        "chapterTitle": generated.get("chapterTitle") or "",
        "createdAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "questions": generated.get("questions") or [],
        "published": bool(set_url or generated.get("setUrl")),
        "className": generated.get("className") or "",
    }
    if persist:
        try:
            key = save_saved_set(class_id, info)
            info["localKey"] = key
            # Also record localKey inside the stored record so the review grid
            # can reference it when publishing later fails (no Blooket URL yet).
            data = load_saved_sets()
            entries = data.get(str(class_id)) or {}
            if key in entries:
                entries[key]["localKey"] = key
                _write_sets(data)
            _append_log("Saved local set (awaiting publish).")
        except Exception as exc:  # noqa: BLE001
            _append_log(f"Could not persist local set: {exc}")
        return info
    return info


def find_set_by_local_key(local_key):
    """Find a set by its local storage key (used to open a set that failed to
    publish and therefore has no Blooket URL). Returns (class_id, key, set_data)
    or (None, None, None)."""
    data = load_saved_sets()
    for class_id, entries in data.items():
        if not isinstance(entries, dict):
            continue
        for key, s in entries.items():
            if key == local_key or s.get("localKey") == local_key:
                return class_id, key, s
    return None, None, None


def find_set_by_url(set_url):
    """Find a set by setUrl. Returns (class_id, key, set_data) or (None, None, None)."""
    data = load_saved_sets()
    for class_id, entries in data.items():
        if not isinstance(entries, dict):
            continue
        for key, s in entries.items():
            if s.get("setUrl") == set_url:
                return class_id, key, s
    return None, None, None


def _resolve_set(data, identifier):
    """Find a (class_id, key) inside the saved sets dict by setUrl or localKey."""
    for class_id, entries in data.items():
        if not isinstance(entries, dict):
            continue
        for key, s in entries.items():
            if not isinstance(s, dict):
                continue
            if identifier and (s.get("setUrl") == identifier or key == identifier):
                return class_id, key
    return None, None


def find_set_by_url_or_local(identifier):
    """Find a set by either its Blooket URL or its local storage key. Returns
    (class_id, key, set_data) or (None, None, None)."""
    if not identifier:
        return None, None, None
    data = load_saved_sets()
    class_id, key = _resolve_set(data, identifier)
    if not class_id:
        return None, None, None
    return class_id, key, data[class_id][key]


def update_set(identifier, updates):
    """Apply updates (title, description, questions) to a set by setUrl OR
    localKey. Returns True if found and saved."""
    data = load_saved_sets()
    class_id, key = _resolve_set(data, identifier)
    if not class_id:
        return False
    s = data[class_id][key]
    if "title" in updates:
        s["title"] = updates["title"]
    if "description" in updates:
        s["description"] = updates["description"]
    if "questions" in updates:
        s["questions"] = updates["questions"]
    os.makedirs(os.path.dirname(BLOOKET_SETS_PATH), exist_ok=True)
    tmp = BLOOKET_SETS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    os.replace(tmp, BLOOKET_SETS_PATH)
    return True


def delete_set(identifier):
    """Delete a set by setUrl OR localKey. Returns True if found and removed."""
    data = load_saved_sets()
    class_id, key = _resolve_set(data, identifier)
    if not class_id:
        return False
    del data[class_id][key]
    os.makedirs(os.path.dirname(BLOOKET_SETS_PATH), exist_ok=True)
    tmp = BLOOKET_SETS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    os.replace(tmp, BLOOKET_SETS_PATH)
    return True


def saved_sets_mtime():
    try:
        return os.path.getmtime(BLOOKET_SETS_PATH)
    except OSError:
        return 0.0


def _append_log(line):
    BLOOKET_JOB["logs"].append(line.rstrip())
    BLOOKET_JOB["logs"] = BLOOKET_JOB["logs"][-2000:]


# Ordered (needle, label) rules mapping the blooket-bot's log lines to a short
# human-readable status shown in the UI. First match wins; more specific rules
# come first so e.g. "Entering title" beats a generic "Entering" fallback.
_STATUS_RULES = [
    ("entering title", "Entering title"),
    ("entering description", "Entering description"),
    ("entering email", "Entering email"),
    ("finding email field", "Entering email"),
    ("entering password", "Entering password"),
    ("finding password field", "Entering password"),
    ("clicking let's go button", "Signing in"),
    ("finding let's go button", "Signing in"),
    ("checking if already logged in", "Checking login"),
    ("navigating to blooket login page", "Opening login page"),
    ("already logged in", "Opening set editor"),
    ("navigating to create set page", "Opening create page"),
    ("clicking csv upload tab", "Choosing CSV import"),
    ("clicking create set button", "Creating set"),
    ("captured new set id", "Creating set"),
    ("waiting for edit page", "Opening editor"),
    ("opening the spreadsheet import modal", "Opening import dialog"),
    ("spreadsheet import button found", "Opening import dialog"),
    ("waiting for file input", "Preparing upload"),
    ("uploading csv", "Uploading questions"),
    ("file injected", "Uploading questions"),
    ("waiting for upload", "Processing upload"),
    ("done waiting, upload should be complete", "Processing upload"),
    ("navigating directly to set", "Opening set editor"),
    ("searching dashboard", "Searching for set"),
    ("starting browser", "Launching browser"),
    ("set_url:", "Set published"),
    ("saved blooket set link", "Saving link"),
]


def _derive_status(line):
    lowered = (line or "").lower()
    for needle, label in _STATUS_RULES:
        if needle in lowered:
            return label
    return ""


# ── Ollama ───────────────────────────────────────────────────────
def _ollama_chat(payload, key):
    request = Request(
        OLLAMA_CHAT_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    try:
        with urlopen(request, timeout=OLLAMA_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise ValueError(f"Ollama Cloud returned HTTP {exc.code}: {exc.reason}")
    except URLError as exc:
        raise ValueError(f"Could not reach Ollama Cloud: {exc.reason}")


def _parse_envelope(reply):
    message = reply.get("message") or {}
    content = str(message.get("content") or "").strip()
    if not content:
        raise ValueError("The AI returned an empty response.")
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*", "", content)
        content = re.sub(r"```$", "", content).strip()
    # Optional AI-generated title/description on the first two lines: TITLE then DESCRIPTION.
    ai_title = ""
    ai_description = ""
    lines = content.split("\n")
    if lines and lines[0].strip().startswith("TITLE:"):
        ai_title = lines[0].strip()[len("TITLE:"):].strip()
        lines = lines[1:]
    if lines and lines[0].strip().startswith("DESCRIPTION:"):
        ai_description = lines[0].strip()[len("DESCRIPTION:"):].strip()
        lines = lines[1:]
    content = "\n".join(lines).strip()
    try:
        data = json.loads(content)
    except Exception:
        data = None
    if data is None:
        start, end = content.find("{"), content.rfind("}")
        if start != -1 and end > start:
            try:
                data = json.loads(content[start:end + 1])
            except Exception:
                data = None
    if isinstance(data, dict) and ("csv" in data or "title" in data or "description" in data):
        result = dict(data)
        result.setdefault("title", ai_title)
        return result
    # If the AI returned a JSON with a "questions" array, convert to CSV
    if isinstance(data, dict) and isinstance(data.get("questions"), list):
        import io
        buf = io.StringIO()
        writer = csv.writer(buf)
        for q in data["questions"]:
            if isinstance(q, dict):
                text = q.get("question") or q.get("text") or q.get("q") or ""
                opts = q.get("options") or q.get("answers") or []
                if isinstance(opts, list):
                    opts = [str(o) for o in opts[:4]]
                while len(opts) < 4:
                    opts.append("")
                correct = q.get("correct") or q.get("answer") or 0
                # CSV format uses 1-indexed correct answer; AI returns 0-indexed
                writer.writerow([text] + opts + [str(correct + 1), "20"])
        csv_content = buf.getvalue()
        if csv_content.strip():
            return {
                "title": data.get("title") or ai_title,
                "description": data.get("description") or ai_description,
                "csv": csv_content,
            }
    # Plain CSV response (no JSON envelope) — treat the whole reply as csv.
    return {"title": ai_title, "description": ai_description, "csv": content}


def _parse_ai_csv(raw):
    rows = []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            fields = next(csv.reader([line]))
        except Exception:
            fields = line.split(",")
        fields = [f.strip() for f in fields]
        if not fields or not fields[0]:
            continue
        if "question" in fields[0].lower():
            continue  # stray header row
        q = fields[0]
        answers = (fields[1:5] + ["", "", "", ""])[:4]
        if not any(answers):
            continue
        try:
            correct = int(float(fields[5])) if len(fields) >= 6 and str(fields[5]).strip() else 1
        except (TypeError, ValueError):
            correct = 1
        if correct < 1 or correct > 4:
            correct = 1
        try:
            time_limit = int(float(fields[6])) if len(fields) >= 7 and str(fields[6]).strip() else 20
        except (TypeError, ValueError):
            time_limit = 20
        if time_limit < 5 or time_limit > 300:
            time_limit = 20
        rows.append([q, answers[0], answers[1], answers[2], answers[3], time_limit, correct])
    return rows


def _write_blooket_csv(rows, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Blooket\nImport Template", "", "", "", "", "", "", ""])
        writer.writerow([
            "Question #",
            "Question Text",
            "Answer 1",
            "Answer 2",
            "Answer 3\n(Optional)",
            "Answer 4\n(Optional)",
            "Time Limit (sec)\n(Max: 300 seconds)",
            "Correct Answer(s)\n(Only include Answer #)",
        ])
        for i, (q, a1, a2, a3, a4, time_limit, correct) in enumerate(rows, start=1):
            writer.writerow([i, q, a1, a2, a3, a4, time_limit, correct])


def _csv_path_for(title):
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40]
    slug = slug or "quiz"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return os.path.join(BLOOKET_SETS_DIR, f"{slug}-{stamp}.csv")


# ── Pipeline ─────────────────────────────────────────────────────
def _build_quiz(settings, key, content, user_msg, default_title, default_description, source_note_id):
    """Ollama → questions → Blooket CSV for any source text. Returns
    {title, description, csvPath, questionCount, sourceNoteId}."""
    messages = [
        {"role": "system", "content": _blooket_system_prompt(settings)},
        {"role": "user", "content": f"Focus prompt: {user_msg}\n\n--- SOURCE MATERIAL ---\n{content[:24000]}"},
    ]
    reply = _ollama_chat(
        {"model": settings.get("ollamaModel") or DEFAULT_MODEL, "stream": False, "messages": messages, "options": {"temperature": 0.4}},
        key,
    )
    envelope = _parse_envelope(reply)
    rows = _parse_ai_csv(envelope.get("csv"))
    if not rows:
        raise ValueError("The AI returned no usable questions. Try again.")

    title = str(envelope.get("title") or "").strip() or default_title
    description = str(envelope.get("description") or "").strip() or default_description

    csv_path = _csv_path_for(title)
    _write_blooket_csv(rows, csv_path)
    questions = [
        {"q": r[0], "options": r[1:5], "correct": max(0, r[6] - 1)}
        for r in rows
    ]
    return {
        "title": title,
        "description": description,
        "csvPath": csv_path,
        "questionCount": len(rows),
        "sourceNoteId": source_note_id,
        "questions": questions,
    }


def generate(settings, class_id, user_prompt, note_id=""):
    """Ollama → questions → Blooket CSV from a class's latest chapter. Returns
    {title, description, csvPath, questionCount, className, chapterTitle}."""
    key = (settings.get("apiKeys") or {}).get("ollama")
    if not key:
        raise ValueError("Add an Ollama Cloud API key in Settings first.")
    note = get_class_note(class_id, settings)
    if not note:
        raise ValueError("This class has no linked notes folder — link it in Settings → Class Notes.")
    if note_id:
        latest = {"noteId": note_id, "title": ""}
    else:
        latest = latest_chapter(note["noteId"], settings)
    if not latest:
        raise ValueError(f"Notes folder '{note.get('noteTitle') or 'this class'}' has no chapter notes.")
    content = get_note_content(latest["noteId"], settings).strip()
    if not content:
        raise ValueError(f"Chapter '{latest['title']}' is empty — nothing to quiz on.")

    user_msg = (str(user_prompt or "").strip() or "(no focus)")
    generated = _build_quiz(
        settings, key, content, user_msg,
        f"{note.get('noteTitle') or 'Class'} {latest.get('title') or 'Chapter'} Review",
        f"Multiple choice review of {latest.get('title') or 'the latest chapter'}.",
        latest.get("noteId") or "",
    )
    generated.update({"className": note.get("noteTitle") or "", "chapterTitle": latest.get("title") or ""})
    return generated


def generate_from_content(settings, content, user_prompt, title_hint="Custom"):
    """Ollama → questions → Blooket CSV from pasted/uploaded text. Returns
    {title, description, csvPath, questionCount, className, chapterTitle}."""
    key = (settings.get("apiKeys") or {}).get("ollama")
    if not key:
        raise ValueError("Add an Ollama Cloud API key in Settings first.")
    content = (content or "").strip()
    if not content:
        raise ValueError("Add some text or a document to build a quiz from.")
    label = (title_hint or "Custom").strip() or "Custom"
    user_msg = (str(user_prompt or "").strip() or "(no focus)")
    generated = _build_quiz(
        settings, key, content, user_msg,
        f"{label} Review",
        f"Multiple choice review of {label}.",
        "content-" + hashlib.sha256(content.encode("utf-8")).hexdigest()[:12],
    )
    generated.update({"className": "Custom", "chapterTitle": label, "custom": True})
    return generated


def _launch_bot(csv_path, title, description, add_to_url=None):
    python = os.path.join(BLOOKET_DIR, "bin", "python")
    command = [
        python,
        os.path.join(BLOOKET_DIR, "test.py"),
        "--title", title,
        "--description", description,
        "--csv", csv_path,
    ]
    if add_to_url:
        command += ["--add-to-url", add_to_url]
    env = dict(os.environ)
    # Run on the real HDMI display (:0, fed by the USB dummy HDMI plug) rather
    # than Xvnc (:1). The virtual VNC display gives Chromium no real vsync, so
    # the renderer's main thread parks forever waiting for a BeginFrame and the
    # Blooket SPA never hydrates. On :0 the KMS connector paces frames normally.
    env["DISPLAY"] = ":0"
    env["XAUTHORITY"] = os.path.join(os.path.expanduser("~"), ".Xauthority")
    # /tmp is a full tmpfs on this box (VNC holds deleted-open files), which can
    # break Chromium — give it a scratch dir on the home disk instead.
    scratch = os.path.join(os.path.expanduser("~"), ".blooket-tmp")
    os.makedirs(scratch, exist_ok=True)
    env["TMPDIR"] = scratch
    return subprocess.Popen(
        command,
        cwd=BLOOKET_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )


def _cleanup_bot_profiles():
    """Remove Chromium/nodriver temp profiles left behind after a run. nodriver
    creates tmp.* dirs under /tmp (and sometimes the scratch dir); they can pile
    up and fill the tmpfs, so sweep them after each bot run completes."""
    import shutil
    scratch = os.path.join(os.path.expanduser("~"), ".blooket-tmp")
    for root in ("/tmp", scratch):
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


def _normalize_set_url(url):
    match = re.search(r"blooket\.com/play/([A-Za-z0-9_-]+)", url or "")
    if match:
        return f"https://dashboard.blooket.com/edit?id={match.group(1)}"
    return url


def _collect_output(process, class_id=None, generated=None):
    for line in iter(process.stdout.readline, ""):
        with _BLOOKET_LOCK:
            _append_log(line)
            status = _derive_status(line)
            if status:
                BLOOKET_JOB["status"] = status
            match = re.search(r"SET_URL:(\S+)", line)
            if match:
                set_url = _normalize_set_url(match.group(1))
                BLOOKET_JOB["result"]["setUrl"] = set_url
                BLOOKET_JOB["result"]["published"] = True
                if class_id and generated and generated.get("persist", True):
                    try:
                        data = load_saved_sets()
                        entries = data.get(str(class_id)) or {}
                        # Find the just-persisted local set (matching source note)
                        source = generated.get("sourceNoteId")
                        for key, s in entries.items():
                            if s.get("published") or s.get("setUrl"):
                                continue
                            if source and s.get("sourceNoteId") == source and s.get("title") == generated.get("title"):
                                s.setdefault("setUrl", "")
                                s["setUrl"] = set_url
                                s["published"] = True
                                s["createdAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
                                _write_sets(data)
                                _append_log("Saved Blooket set link for this class.")
                                break
                    except Exception as exc:  # noqa: BLE001
                        _append_log(f"Could not persist set link: {exc}")
    code = process.wait()
    with _BLOOKET_LOCK:
        BLOOKET_JOB["exitCode"] = code
        BLOOKET_JOB["phase"] = "done" if code == 0 else "failed"
        BLOOKET_JOB["status"] = "Set published" if code == 0 else "Publish failed"
        BLOOKET_JOB["process"] = None
        _append_log(f"Blooket publish finished with exit code {code}.")
    _cleanup_bot_profiles()
    _pump_queue()


def _pipeline_worker(class_id, prompt, note_id=""):
    with _BLOOKET_LOCK:
        BLOOKET_JOB.update({
            "process": None,
            "logs": [f"Generating quiz for class {class_id}…"],
            "exitCode": None,
            "phase": "generating",
            "status": "Asking Ollama for questions",
            "result": {"classId": class_id, "prompt": prompt},
            "jobId": BLOOKET_JOB.get("jobId"),
            "cancelRequested": False,
        })
    try:
        settings = load_settings()
        generated = generate(settings, class_id, prompt, note_id=note_id)
        with _BLOOKET_LOCK:
            BLOOKET_JOB["result"].update(generated)
            _append_log(
                f"Ollama generated {generated['questionCount']} questions → "
                f"{os.path.basename(generated['csvPath'])}"
            )
            BLOOKET_JOB["phase"] = "publishing"
            BLOOKET_JOB["status"] = "Launching Blooket bot"
            # Persist the local set immediately so the questions are never lost,
            # even if the bot fails or stalls. Capture the key to attach the URL later.
            BLOOKET_JOB["result"]["localKey"] = _persist_generated_set(class_id, generated, persist=True)
        if cancel_requested():
            _mark_cancelled(class_id)
            _pump_queue()
            return
        process = _launch_bot(generated["csvPath"], generated["title"], generated["description"])
        with _BLOOKET_LOCK:
            BLOOKET_JOB["process"] = process
            _append_log("Starting blooket-bot: " + " ".join(process.args))
        threading.Thread(target=_collect_output, args=(process, class_id, generated), daemon=True).start()
    except Exception as exc:  # noqa: BLE001 — surface every failure to the UI
        with _BLOOKET_LOCK:
            BLOOKET_JOB["phase"] = "failed"
            BLOOKET_JOB["exitCode"] = 1
            BLOOKET_JOB["result"]["error"] = str(exc)
            _append_log(f"Failed: {exc}")
        _pump_queue()


def _mark_cancelled(class_id):
    with _BLOOKET_LOCK:
        BLOOKET_JOB["phase"] = "cancelled"
        BLOOKET_JOB["exitCode"] = None
        BLOOKET_JOB["status"] = "Cancelled"
        BLOOKET_JOB["result"]["error"] = "Cancelled before publish."
        _append_log("Job cancelled.")


def start_pipeline(class_id, prompt, note_id=""):
    """Start the background job, or queue it if one is already running.
    Returns dict with started/queued id."""
    status = job_status()
    if status["running"]:
        jid = enqueue({
            "type": "class",
            "class_id": class_id,
            "prompt": prompt,
            "note_id": note_id,
            "label": f"Class {class_id}",
            "meta": {"classId": class_id, "noteId": note_id},
        })
        return {"started": False, "queued": True, "id": jid}
    _start_class_job(class_id, prompt, note_id)
    return {"started": True, "queued": False, "id": None}


def _start_class_job(class_id, prompt, note_id):
    with _BLOOKET_LOCK:
        BLOOKET_JOB["jobId"] = _new_job_id()
    threading.Thread(target=_pipeline_worker, args=(class_id, prompt, note_id), daemon=True).start()


def _pump_queue():
    """After the current job finishes, pull the next queued job and run it."""
    with _BLOOKET_LOCK:
        job = _QUEUE.pop(0) if _QUEUE else None
    if not job:
        return
    spec = job["spec"]
    _clear_cancel()
    if spec.get("type") == "class":
        _start_class_job(spec["class_id"], spec["prompt"], spec.get("note_id") or "")
    else:
        _start_custom_job(spec["content"], spec["prompt"], spec.get("set_url") or "", spec.get("label") or "Custom")


def _custom_pipeline_worker(content, prompt, set_url, label):
    with _BLOOKET_LOCK:
        BLOOKET_JOB.update({
            "process": None,
            "logs": ["Generating quiz from your content…"],
            "exitCode": None,
            "phase": "generating",
            "status": "Asking Ollama for questions",
            "result": {
                "classId": "custom",
                "persist": not bool(set_url),
                "custom": True,
                "prompt": prompt,
                "addToUrl": set_url,
            },
            "jobId": BLOOKET_JOB.get("jobId"),
            "cancelRequested": False,
        })
    try:
        settings = load_settings()
        generated = generate_from_content(settings, content, prompt, title_hint=label)
        with _BLOOKET_LOCK:
            BLOOKET_JOB["result"].update(generated)
            _append_log(
                f"Ollama generated {generated['questionCount']} questions → "
                f"{os.path.basename(generated['csvPath'])}"
            )
            BLOOKET_JOB["phase"] = "publishing"
            BLOOKET_JOB["status"] = "Launching Blooket bot"
            persist = not bool(set_url)
            generated["persist"] = persist
            if persist:
                BLOOKET_JOB["result"]["localKey"] = _persist_generated_set("custom", generated, persist=True)
        if cancel_requested():
            _mark_cancelled("custom")
            _pump_queue()
            return
        process = _launch_bot(generated["csvPath"], generated["title"], generated["description"], add_to_url=set_url)
        with _BLOOKET_LOCK:
            BLOOKET_JOB["process"] = process
            _append_log("Starting blooket-bot: " + " ".join(process.args))
        threading.Thread(target=_collect_output, args=(process, "custom" if persist else None, generated if persist else None), daemon=True).start()
    except Exception as exc:  # noqa: BLE001 — surface every failure to the UI
        with _BLOOKET_LOCK:
            BLOOKET_JOB["phase"] = "failed"
            BLOOKET_JOB["exitCode"] = 1
            BLOOKET_JOB["result"]["error"] = str(exc)
            _append_log(f"Failed: {exc}")
        _pump_queue()


def start_custom_pipeline(content, prompt, set_url=None, label="Custom"):
    """Start the background job from pasted/uploaded content, or queue it."""
    status = job_status()
    if status["running"]:
        jid = enqueue({
            "type": "custom",
            "content": content,
            "prompt": prompt or "",
            "set_url": set_url or "",
            "label": label or "Custom",
            "meta": {"custom": True, "label": label or "Custom"},
        })
        return {"started": False, "queued": True, "id": jid}
    _start_custom_job(content, prompt or "", set_url or "", label or "Custom")
    return {"started": True, "queued": False, "id": None}


def _start_custom_job(content, prompt, set_url, label):
    with _BLOOKET_LOCK:
        BLOOKET_JOB["jobId"] = _new_job_id()
    threading.Thread(target=_custom_pipeline_worker, args=(content, prompt, set_url, label), daemon=True).start()
