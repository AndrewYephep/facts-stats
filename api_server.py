"""
Small API that receives Google Classroom homework data from Apps Script
and stores it for the cron job to pick up when it builds the combined email.

Run persistently (systemd or docker), exposed through your existing
Cloudflare Tunnel at whatever hostname you route to this port.

    pip install flask --break-system-packages
    python3 api_server.py
"""

import json
import logging
import os
import secrets
import time
from pathlib import Path

from flask import Flask, request, jsonify

log = logging.getLogger(__name__)


def _load_dotenv():
    env_path = Path(__file__).parent / ".env"
    if not env_path.is_file():
        return
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
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

app = Flask(__name__)

DATA_DIR = Path(__file__).parent
CLASSROOM_FILE = DATA_DIR / "classroom_latest.json"
CLASSROOM_ASSIGNMENTS_FILE = DATA_DIR / "data" / "classroom_assignments.json"

# Must be set in the environment (.env via systemd EnvironmentFile, or the unit's
# Environment= directive). Refuses to start without it.
API_KEY = os.environ.get("CLASSROOM_API_KEY")
if not API_KEY:
    raise RuntimeError("CLASSROOM_API_KEY is not set; refusing to start without it.")


def _unauthorized():
    return jsonify({"error": "unauthorized"}), 401


@app.route("/classroom-update", methods=["POST"])
def classroom_update():
    key = request.headers.get("X-API-Key")
    if not key or not secrets.compare_digest(key, API_KEY):
        return _unauthorized()

    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"error": "invalid or missing JSON body"}), 400

    # Expected payload shape (adjust in your Apps Script to match):
    # {
    #   "run": "morning" | "afternoon",
    #   "generated_at": "2026-07-25T06:00:00-04:00",
    #   "classes": [
    #     {
    #       "name": "AP Chemistry",
    #       "color": "#8ab4f8",          # optional accent per class
    #       "assignments": [
    #         {
    #           "title": "Lab Report 4",
    #           "due": "2026-07-26",
    #           "due_label": "Tomorrow",
    #           "status": "missing" | "due_tonight" | "upcoming" | "done",
    #           "link": "https://classroom.google.com/..."
    #         }
    #       ]
    #     }
    #   ]
    # }

    payload["received_at"] = time.time()

    CLASSROOM_FILE.write_text(json.dumps(payload, indent=2))

    return jsonify({"status": "ok", "stored_assignments": _count_assignments(payload)})


@app.route("/classroom-latest", methods=["GET"])
def classroom_latest():
    """Used by the cron job to fetch what Apps Script most recently posted."""
    key = request.headers.get("X-API-Key")
    if not key or not secrets.compare_digest(key, API_KEY):
        return _unauthorized()

    if not CLASSROOM_FILE.exists():
        return jsonify({"error": "no data yet"}), 404

    return jsonify(json.loads(CLASSROOM_FILE.read_text()))


@app.route("/classroom-sync", methods=["POST"])
def classroom_sync():
    """Receives the full assignment list from Apps Script (same payload shape
    as the Trilium /sync bridge) and stores it for the dashboard calendar.

    Expected body: {"assignments": [ {normaliseCourseWork fields}, ... ]}
    """
    key = request.headers.get("X-API-Key")
    if not key or not secrets.compare_digest(key, API_KEY):
        return _unauthorized()

    payload = request.get_json(silent=True)
    if not payload or not isinstance(payload, dict):
        return jsonify({"error": "invalid or missing JSON body"}), 400

    assignments = payload.get("assignments")
    if not isinstance(assignments, list):
        return jsonify({"error": "expected an 'assignments' list"}), 400

    record = {
        "assignments": assignments,
        "count": len(assignments),
        "received_at": time.time(),
        "received_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    CLASSROOM_ASSIGNMENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CLASSROOM_ASSIGNMENTS_FILE.write_text(json.dumps(record, indent=2))

    return jsonify({"status": "ok", "stored": len(assignments)})


@app.route("/classroom-assignments", methods=["GET"])
def classroom_assignments():
    """Used by classroom_client.py to fetch the full synced assignment list."""
    key = request.headers.get("X-API-Key")
    if not key or not secrets.compare_digest(key, API_KEY):
        return _unauthorized()

    if not CLASSROOM_ASSIGNMENTS_FILE.exists():
        return jsonify({"error": "no data yet"}), 404

    return jsonify(json.loads(CLASSROOM_ASSIGNMENTS_FILE.read_text()))


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


def _count_assignments(payload):
    return sum(len(c.get("assignments", [])) for c in payload.get("classes", []))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8787)