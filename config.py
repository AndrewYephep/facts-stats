# SIS (FactsMgmt) credentials must live in the environment (.env via systemd
# EnvironmentFile, or the unit's Environment= directive). When unset, the
# values stay None and the scraper raises a clear error at run time — the
# dashboard UI still loads so you can rotate the password without downtime.
import logging
import os

log = logging.getLogger(__name__)

# Load .env ourselves so every process that imports config.py (the standalone
# scraper, emailer, rollover script — not just the dashboard) picks up the
# credentials. Already-set vars win, so this never clobbers real env.
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

DISTRICT_CODE = os.environ.get("DISTRICT_CODE", "col-in")
SIS_USERNAME = os.environ.get("SIS_USERNAME")
SIS_PASSWORD = os.environ.get("SIS_PASSWORD")
if not (SIS_USERNAME and SIS_PASSWORD):
    log.warning(
        "SIS_USERNAME and/or SIS_PASSWORD are not set; the FACTS scraper "
        "will fail until you populate them in .env."
    )

# --- Grades scraper & dashboard ---

# Class IDs from FACTS (data-classid on <option>) to ignore completely.
SKIP_CLASS_IDS = [
    # "6165",  # Lunch
    # "6212",  # Student Demerits
]

# Substrings matched against full class display name (case-insensitive).
SKIP_CLASS_NAME_PATTERNS = [
    "Study Hall",
    "Homeroom",
    "Chapel",
    "Lunch",
    "Merit",
    "Demerit",
    "POWER Group",
]

# Terms to scrape: [4] = current quarter only; [1, 2, 3, 4] = backfill all quarters.
SCRAPE_TERMS = [1]
CURRENT_TERM = 1
ACADEMIC_YEAR = "2026-27"

# Flag grades below this percent (assignments & category averages).
ATTENTION_PERCENT_THRESHOLD = 95

# Orange watchlist: always show lowest class + this many lowest category grades.
WATCHLIST_BOTTOM_CATEGORIES = 3

GRADES_JSON_PATH = "/home/ahepworth/facts-stats/grades_data.json"
GRADES_HISTORY_PATH = "/home/ahepworth/facts-stats/grades_history.json"
GRADES_DASHBOARD_PATH = "/home/ahepworth/facts-stats/grades_dashboard.html"
