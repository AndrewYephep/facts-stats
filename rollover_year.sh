#!/usr/bin/env bash
# rollover_year.sh — end-of-year rollover for the FACTS grades scraper.
#
# FACTS reassigns every class id when the school year changes, so the live
# grades_data.json would just mix last year's classes in with the new ones.
# This script archives the old year's scraper data, bumps the academic year
# (and current term) in config.py, then starts a fresh scrape so the new
# year's class roster and grades are loaded from scratch.
#
# Usage — must run on the Pi (its venv/Chromium can't run from the Mac mount):
#   ssh pi "bash ~/facts-stats/rollover_year.sh 2026-27"
#   ssh pi "bash ~/facts-stats/rollover_year.sh 2026-27 --term q2"
#
#   positional  NEW_YEAR  new academic year, e.g. 2026-27 (prompted if omitted)
#   --term qN             term to scrape and mark current: q1..q4 (default q1)

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ "$(uname -s)" = "Darwin" ]; then
  echo "ERROR: this must run on the Pi — the Mac cannot execute the Pi's venv/Chromium."
  echo "       Use: ssh pi 'bash ~/facts-stats/rollover_year.sh ...'"
  exit 1
fi

# --- Arguments -------------------------------------------------------------
NEW_YEAR="${1:-}"
TERM_ARG="q1"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --term) TERM_ARG="${2:-q1}"; shift 2 ;;
    *) shift ;;
  esac
done

case "$TERM_ARG" in
  q1) TERM_NUM=1 ;; q2) TERM_NUM=2 ;; q3) TERM_NUM=3 ;; q4) TERM_NUM=4 ;;
  *) echo "ERROR: --term must be q1, q2, q3 or q4"; exit 1 ;;
esac

# --- Sanity checks ---------------------------------------------------------
OLD_YEAR="$(grep -oE 'ACADEMIC_YEAR[[:space:]]*=[[:space:]]*"[^"]+"' config.py | grep -oE '"[^"]+"' | tr -d '"')"
if [ -z "$OLD_YEAR" ]; then
  echo "ERROR: could not read ACADEMIC_YEAR from config.py"
  exit 1
fi

if [ -z "$NEW_YEAR" ]; then
  read -r -p "New academic year (e.g. 2026-27): " NEW_YEAR
fi
if ! echo "$NEW_YEAR" | grep -qE '^[0-9]{4}-[0-9]{2}$'; then
  echo "ERROR: new year must look like 2026-27 (got '$NEW_YEAR')"
  exit 1
fi
if [ "$NEW_YEAR" = "$OLD_YEAR" ]; then
  echo "ERROR: new year ($NEW_YEAR) is the same as the current year"
  exit 1
fi

echo "Current year: $OLD_YEAR"
echo "New year:     $NEW_YEAR  (term $TERM_ARG = Q$TERM_NUM)"

# --- 1. Archive the old year's scraper data -------------------------------
ARCHIVE="data/archive/$OLD_YEAR"
mkdir -p "$ARCHIVE"
echo
echo "=== Archiving $OLD_YEAR scraper data -> $ARCHIVE ==="

# Live snapshot: moved out so the new scrape starts with a clean roster.
for f in grades_data.json grades_dashboard.html; do
  if [ -f "$f" ]; then mv -v "$f" "$ARCHIVE/"; fi
done

# History + settings: copied (kept live) so nothing is lost.
for f in grades_history.json data/settings.json; do
  if [ -f "$f" ]; then cp -v "$f" "$ARCHIVE/$(basename "$f")"; fi
done

# --- 2. Bump academic year / term in config.py ----------------------------
echo
echo "=== Updating config.py: year $OLD_YEAR -> $NEW_YEAR, term -> Q$TERM_NUM ==="
python3 - "$NEW_YEAR" "$TERM_NUM" <<'PY'
import re, sys
new_year, term = sys.argv[1], sys.argv[2]
path = "config.py"
src = open(path, encoding="utf-8").read()
src, n1 = re.subn(r'ACADEMIC_YEAR\s*=\s*"[^"]*"', f'ACADEMIC_YEAR = "{new_year}"', src, count=1)
src, n2 = re.subn(r'CURRENT_TERM\s*=\s*\d+', f'CURRENT_TERM = {term}', src, count=1)
src, n3 = re.subn(r'SCRAPE_TERMS\s*=\s*\[[^\]]*\]', f'SCRAPE_TERMS = [{term}]', src, count=1)
if not (n1 and n2 and n3):
    raise SystemExit(f"config.py edit incomplete (year={n1}, current_term={n2}, terms={n3})")
open(path, "w", encoding="utf-8").write(src)
PY
echo "config.py updated."

# --- 3. Trigger a fresh scrape of the new year's classes -------------------
echo
echo "=== Starting fresh scrape for $NEW_YEAR (--period $TERM_ARG --classes all) ==="
if pgrep -f "sis_login.py" >/dev/null; then
  echo "ERROR: a scrape is already running — archive + config update are done,"
  echo "       but the fresh scrape was NOT started. Re-run once it finishes."
  exit 1
fi

mkdir -p logs
LOG="logs/scrape-${NEW_YEAR}-$(date +%Y%m%d-%H%M%S).log"
nohup env DISPLAY=:1 XAUTHORITY="$HOME/.Xauthority" \
  "$DIR/venv/bin/python" "$DIR/sis_login.py" --period "$TERM_ARG" --classes all \
  > "$LOG" 2>&1 &
echo "Scrape launched (pid $!). Log: $LOG"
echo "This takes several minutes; the dashboard will show new classes once it lands."

# --- 4. Restart dashboard so it picks up the new config --------------------
echo
if sudo -n systemctl restart facts-dashboard.service 2>/dev/null; then
  echo "Dashboard restarted with the new academic year."
else
  echo "NOTE: could not restart the dashboard (needs sudo). Restart manually:"
  echo "      sudo systemctl restart facts-dashboard.service"
fi
