"""Fetch the latest Classroom homework payload posted by Apps Script.

The Flask API (api_server.py) runs locally on this same Pi, so this just
hits localhost — no tunnel needed for this leg.
"""

import logging
import time

import requests

log = logging.getLogger(__name__)

CLASSROOM_API_URL = "http://localhost:8787/classroom-latest"
CLASSROOM_ASSIGNMENTS_URL = "http://localhost:8787/classroom-assignments"
CLASSROOM_API_KEY = "JZ2hOfp64wm-YCaacMmQ0Oxtf5hZVgdD46vXyYpCsq0"  # must match api_server.py
FRESHNESS_MAX_AGE_SECONDS = 3 * 60 * 60  # ignore stale data >3h old


def fetch_classroom_payload():
    """Returns the classroom payload dict, or None if unavailable/stale."""
    try:
        resp = requests.get(
            CLASSROOM_API_URL,
            headers={"X-API-Key": CLASSROOM_API_KEY},
            timeout=5,
        )
        if resp.status_code != 200:
            log.info("No classroom data available (status %s)", resp.status_code)
            return None

        payload = resp.json()
        age = time.time() - payload.get("received_at", 0)
        if age > FRESHNESS_MAX_AGE_SECONDS:
            log.info("Classroom data stale (%.0fs old), skipping homework section", age)
            return None

        return payload
    except requests.RequestException as exc:
        log.warning("Could not reach classroom API: %s", exc)
        return None


def fetch_classroom_assignments():
    """Returns the full synced assignment list [{...normaliseCourseWork}, ...]
    or None if unavailable. No freshness gate here: the dashboard calendar
    reads this file directly, so staleness is handled by the daily sync."""
    try:
        resp = requests.get(
            CLASSROOM_ASSIGNMENTS_URL,
            headers={"X-API-Key": CLASSROOM_API_KEY},
            timeout=5,
        )
        if resp.status_code != 200:
            log.info("No classroom assignments available (status %s)", resp.status_code)
            return None

        record = resp.json()
        return record.get("assignments") or []
    except requests.RequestException as exc:
        log.warning("Could not reach classroom API: %s", exc)
        return None