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

OLLAMA_CHAT_URL = "https://ollama.com/api/chat"
DEFAULT_MODEL = "gpt-oss:120b"
OLLAMA_TIMEOUT = 240

# Native path on the Raspberry Pi; override via env for local testing.
BLOOKET_DIR = os.environ.get("BLOOKET_DIR") or "/home/ahepworth/blooket-bot"
BLOOKET_SETS_DIR = os.path.join(BLOOKET_DIR, "sets")
BLOOKET_SETS_PATH = os.path.join(os.path.dirname(__file__), "data", "blooket_sets.json")

BLOOKET_SYSTEM_PROMPT = """this is the format and goal: convert the user's notes into multiple choice quiz questions formatted for Blooket import.

OUTPUT FORMAT:
- The very first line of your response must be the quiz title, formatted exactly as: TITLE: <short review title drawn from the material>
- The second line must be a one-sentence description, formatted exactly as: DESCRIPTION: <one sentence describing what this quiz covers>
- After the description line, output ONLY the CSV question lines — no headers, no explanations, no markdown

- Key mistake: When the question contains commas that break the CSV formatting.
- Each line has EXACTLY 7 comma-separated fields in this order:
 Question Text, Answer 1, Answer 2, Answer 3, Answer 4, Correct Answer Number (1-4), Time in seconds

QUESTION REQUIREMENTS:
Make questions using the definition being turned into the question, and the terms that relate as options (with the correct option of course)

FORMATTING RULES:
- Do NOT include a header row
- Do NOT wrap fields or lines in quotes
- Do NOT use commas within questions or answers — use semicolons instead if needed
- The correct answer is a NUMBER (1-4), not text
- Use 20 for all time limits

EXAMPLE OUTPUT:
TITLE: Early Roman Culture Review
Which civilization influenced early Roman culture?,Greeks,Egyptians,Persians,Chinese,1,20

Generate as many quality questions as the source material allows. Focus on creating great questions with quality options, and making a comprehensive (and in most cases exhaustive quiz set). Generate the quiz set directly as the response (within a text box for easy copying), and just follow any further specifications by the user."""


# ── Job state (single worker at a time) ─────────────────────────
BLOOKET_JOB = {
    "process": None,
    "logs": [],
    "exitCode": None,
    "phase": "idle",  # idle | generating | publishing | done | failed
    "status": "",     # human-readable current step (e.g. "Entering title")
    "result": {},
}
_BLOOKET_LOCK = threading.Lock()


def job_status():
    with _BLOOKET_LOCK:
        process = BLOOKET_JOB["process"]
        running = bool(process and process.poll() is None) or BLOOKET_JOB["phase"] == "generating"
        return {
            "running": running,
            "phase": BLOOKET_JOB["phase"],
            "status": BLOOKET_JOB["status"],
            "exitCode": BLOOKET_JOB["exitCode"],
            "logs": list(BLOOKET_JOB["logs"]),
            "result": dict(BLOOKET_JOB["result"] or {}),
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
    chapter note accumulate instead of overwriting the previous link."""
    data = load_saved_sets()
    source = info.get("sourceNoteId") or "custom"
    key = f"{source}__{uuid.uuid4().hex[:8]}"
    data.setdefault(str(class_id), {})[key] = info
    os.makedirs(os.path.dirname(BLOOKET_SETS_PATH), exist_ok=True)
    tmp = BLOOKET_SETS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
    os.replace(tmp, BLOOKET_SETS_PATH)


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


def update_set(set_url, updates):
    """Apply updates (title, description, questions) to a set by setUrl. Returns True if found and saved."""
    data = load_saved_sets()
    for class_id, entries in data.items():
        if not isinstance(entries, dict):
            continue
        for key, s in entries.items():
            if s.get("setUrl") == set_url:
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
    return False


def delete_set(set_url):
    """Delete a set by setUrl. Returns True if found and removed."""
    data = load_saved_sets()
    for class_id, entries in data.items():
        if not isinstance(entries, dict):
            continue
        for key in list(entries.keys()):
            if entries[key].get("setUrl") == set_url:
                del entries[key]
                os.makedirs(os.path.dirname(BLOOKET_SETS_PATH), exist_ok=True)
                tmp = BLOOKET_SETS_PATH + ".tmp"
                with open(tmp, "w", encoding="utf-8") as handle:
                    json.dump(data, handle, indent=2)
                os.replace(tmp, BLOOKET_SETS_PATH)
                return True
    return False


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
        {"role": "system", "content": BLOOKET_SYSTEM_PROMPT},
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


def generate(settings, class_id, user_prompt):
    """Ollama → questions → Blooket CSV from a class's latest chapter. Returns
    {title, description, csvPath, questionCount, className, chapterTitle}."""
    key = (settings.get("apiKeys") or {}).get("ollama")
    if not key:
        raise ValueError("Add an Ollama Cloud API key in Settings first.")
    note = get_class_note(class_id, settings)
    if not note:
        raise ValueError("This class has no linked notes folder — link it in Settings → Class Notes.")
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
    env["DISPLAY"] = ":1"
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


def _normalize_set_url(url):
    match = re.search(r"blooket\.com/play/([A-Za-z0-9_-]+)", url or "")
    if match:
        return f"https://dashboard.blooket.com/edit?id={match.group(1)}"
    return url


def _collect_output(process):
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
                try:
                    res = BLOOKET_JOB["result"]
                    if res.get("classId") and res.get("persist", True):
                        save_saved_set(res["classId"], {
                            "setUrl": set_url,
                            "sourceNoteId": res.get("sourceNoteId"),
                            "title": res.get("title"),
                            "description": res.get("description", ""),
                            "questionCount": res.get("questionCount"),
                            "chapterTitle": res.get("chapterTitle"),
                            "createdAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                            "questions": res.get("questions") or [],
                        })
                        _append_log("Saved Blooket set link for this class.")
                except Exception as exc:  # noqa: BLE001 — never let persistence break the job
                    _append_log(f"Could not persist set link: {exc}")
    code = process.wait()
    with _BLOOKET_LOCK:
        BLOOKET_JOB["exitCode"] = code
        BLOOKET_JOB["phase"] = "done" if code == 0 else "failed"
        BLOOKET_JOB["status"] = "Set published" if code == 0 else "Publish failed"
        _append_log(f"Blooket publish finished with exit code {code}.")


def _pipeline_worker(class_id, prompt):
    with _BLOOKET_LOCK:
        BLOOKET_JOB.update({
            "process": None,
            "logs": [f"Generating quiz for class {class_id}…"],
            "exitCode": None,
            "phase": "generating",
            "status": "Asking Ollama for questions",
            "result": {"classId": class_id, "prompt": prompt},
        })
    try:
        settings = load_settings()
        generated = generate(settings, class_id, prompt)
        with _BLOOKET_LOCK:
            BLOOKET_JOB["result"].update(generated)
            _append_log(
                f"Ollama generated {generated['questionCount']} questions → "
                f"{os.path.basename(generated['csvPath'])}"
            )
            BLOOKET_JOB["phase"] = "publishing"
            BLOOKET_JOB["status"] = "Launching Blooket bot"
        process = _launch_bot(generated["csvPath"], generated["title"], generated["description"])
        with _BLOOKET_LOCK:
            BLOOKET_JOB["process"] = process
            _append_log("Starting blooket-bot: " + " ".join(process.args))
        threading.Thread(target=_collect_output, args=(process,), daemon=True).start()
    except Exception as exc:  # noqa: BLE001 — surface every failure to the UI
        with _BLOOKET_LOCK:
            BLOOKET_JOB["phase"] = "failed"
            BLOOKET_JOB["exitCode"] = 1
            BLOOKET_JOB["result"]["error"] = str(exc)
            _append_log(f"Failed: {exc}")


def start_pipeline(class_id, prompt):
    """Start the background job if none is running. Returns True on success."""
    status = job_status()
    if status["running"]:
        return False
    threading.Thread(target=_pipeline_worker, args=(class_id, prompt), daemon=True).start()
    return True


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
        process = _launch_bot(generated["csvPath"], generated["title"], generated["description"], add_to_url=set_url)
        with _BLOOKET_LOCK:
            BLOOKET_JOB["process"] = process
            _append_log("Starting blooket-bot: " + " ".join(process.args))
        threading.Thread(target=_collect_output, args=(process,), daemon=True).start()
    except Exception as exc:  # noqa: BLE001 — surface every failure to the UI
        with _BLOOKET_LOCK:
            BLOOKET_JOB["phase"] = "failed"
            BLOOKET_JOB["exitCode"] = 1
            BLOOKET_JOB["result"]["error"] = str(exc)
            _append_log(f"Failed: {exc}")


def start_custom_pipeline(content, prompt, set_url=None, label="Custom"):
    """Start the background job from pasted/uploaded content if none is running."""
    status = job_status()
    if status["running"]:
        return False
    threading.Thread(target=_custom_pipeline_worker, args=(content, prompt or "", set_url or "", label or "Custom"), daemon=True).start()
    return True
