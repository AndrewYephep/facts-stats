#!/bin/bash
# deploy.sh — bump the cache-buster, sanity-check, and restart the running service.
#
# Works in two environments:
#   - Mac with PiFileSystem mounted (e.g. /Users/ahepw/PiFileSystem/...): edits are
#     already on the Pi, so no scp is needed — just restart the service.
#   - Anywhere else: scp the files to the Pi over SSH, then restart.
#
# The script auto-detects which mode to use based on whether the repo root lives
# under /home/ahepworth/facts-stats (the Pi mount) or not.
#
# Usage: ./deploy.sh           # full deploy
#        ./deploy.sh --skip-py  # only deploy the frontend
#        ./deploy.sh --skip-fe  # only deploy the Python files
#        ./deploy.sh --dry-run  # show what would happen, do nothing
#
# After this runs, hard-refresh the browser (Cmd/Ctrl+Shift+R) to clear cache.

set -euo pipefail

# --- Config -------------------------------------------------------------------
PI_HOST="${PI_HOST:-pi}"
PI_ROOT="${PI_ROOT:-/home/ahepworth/facts-stats}"
PI_GRADETRACK="$PI_ROOT/gradetrack"
SERVICE_NAME="${SERVICE_NAME:-facts-dashboard.service}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRADETRACK="$REPO_ROOT/gradetrack"
APP_JS="$GRADETRACK/js/app.js"
INDEX_HTML="$GRADETRACK/index.html"
PY_SRC=("$GRADETRACK/dashboard_server.py" "$GRADETRACK/blooket_builder.py")
PY_DST=("$PI_ROOT/dashboard_server.py" "$PI_ROOT/blooket_builder.py")

# --- Auto-detect: are we on the Pi mount? ------------------------------------
# If the repo path lives under /home/ahepworth (the Pi mount on a Mac), edits
# are already on the Pi. Skip the scp step entirely.
if [[ "$REPO_ROOT" == *"/home/ahepworth/facts-stats"* ]]; then
  PI_MOUNT=1
  TARGET_DESC="local Pi mount ($REPO_ROOT)"
else
  PI_MOUNT=0
  TARGET_DESC="$PI_HOST:$PI_ROOT"
fi

# --- Flags --------------------------------------------------------------------
SKIP_PY=0
SKIP_FE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-py) SKIP_PY=1 ;;
    --skip-fe) SKIP_FE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- Helpers ------------------------------------------------------------------
# Why not eval "$@"? Because eval re-parses shell metacharacters (| & ; etc.)
# in the arguments, which corrupts sed -E 's|foo|bar|' expressions. We build a
# printable string separately and execute "$@" directly.
run() {
  local cmd=""
  for arg in "$@"; do
    if [[ -z "$cmd" ]]; then cmd="$arg"; else cmd="$cmd $arg"; fi
  done
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '\033[36m[dry-run]\033[0m %s\n' "$cmd"
  else
    printf '\033[36m[run]\033[0m %s\n' "$cmd"
    "$@"
  fi
}

ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- Preflight ----------------------------------------------------------------
printf '\033[1mGradeTrack deploy\033[0m\n'
printf '  repo:     %s\n' "$REPO_ROOT"
printf '  target:   %s\n' "$TARGET_DESC"
echo

[[ -f "$APP_JS"      ]] || die "missing $APP_JS"
[[ -f "$INDEX_HTML"  ]] || die "missing $INDEX_HTML"
for f in "${PY_SRC[@]}"; do
  [[ -f "$f" ]] || die "missing $f"
done

# --- 1. Syntax check -----------------------------------------------------------
printf '\033[1m[1/3] Syntax check\033[0m\n'
if [[ $SKIP_FE -eq 0 ]]; then
  if command -v node >/dev/null 2>&1; then
    run node --check "$APP_JS"
    ok "app.js parses"
  else
    warn "node not found; skipping JS syntax check"
  fi
fi
if [[ $SKIP_PY -eq 0 ]]; then
  if command -v python3 >/dev/null 2>&1; then
    # Resolve symlinks (gradetrack/*.py may be symlinks to ../*.py on the Pi).
    for src in "${PY_SRC[@]}"; do
      real_src="$(readlink -f "$src")"
      [[ -f "$real_src" ]] || die "could not resolve $src"
      run python3 -m py_compile "$real_src"
    done
    ok "Python files compile"
  else
    warn "python3 not found; skipping Python syntax check"
  fi
fi
echo

# --- 2. Bump the cache-buster ------------------------------------------------
printf '\033[1m[2/3] Bump cache-buster in index.html\033[0m\n'
if [[ $SKIP_FE -eq 0 ]]; then
  current=$(grep -oE 'app\.js\?v=[0-9]+' "$INDEX_HTML" | head -n1 | grep -oE '[0-9]+$') || current=""
  if [[ -z "$current" ]]; then
    die "could not find ?v=N in $INDEX_HTML"
  fi
  next=$((current + 1))
  # Bump every ?v=N reference in index.html in one pass — covers app.js plus
  # any blooket-*.js modules that happen to be loaded.
  run sed -i.bak -E "s|\\?v=${current}|\?v=${next}|g" "$INDEX_HTML"
  ok "bumped v=${current} → v=${next}"
  run rm -f "$INDEX_HTML.bak"
fi
echo

# --- 3. Push (if needed) and restart service --------------------------------
printf '\033[1m[3/3] Push and restart service\033[0m\n'
if [[ $SKIP_FE -eq 0 && $PI_MOUNT -eq 0 ]]; then
  run scp "$APP_JS"     "$PI_HOST:$PI_GRADETRACK/js/app.js"
  run scp "$INDEX_HTML" "$PI_HOST:$PI_GRADETRACK/index.html"
  ok "frontend scp'd to Pi"
elif [[ $SKIP_FE -eq 0 ]]; then
  ok "frontend already on Pi mount (no scp needed)"
fi
if [[ $SKIP_PY -eq 0 && $PI_MOUNT -eq 0 ]]; then
  for i in "${!PY_SRC[@]}"; do
    run scp "${PY_SRC[$i]}" "$PI_HOST:${PY_DST[$i]}"
  done
  ok "Python scp'd to Pi"
elif [[ $SKIP_PY -eq 0 ]]; then
  ok "Python already on Pi mount (no scp needed)"
fi
if [[ $PI_MOUNT -eq 1 ]]; then
  # Files are on the Pi mount, but the service runs on the Pi. If we can't sudo
  # locally (Mac user with no passwordless sudo), fall back to ssh.
  if sudo -n true 2>/dev/null; then
    run sudo -n systemctl restart "$SERVICE_NAME"
    run systemctl is-active "$SERVICE_NAME"
  else
    run ssh "$PI_HOST" "sudo -n systemctl restart $SERVICE_NAME && systemctl is-active $SERVICE_NAME"
  fi
else
  run ssh "$PI_HOST" "sudo -n systemctl restart $SERVICE_NAME && systemctl is-active $SERVICE_NAME"
fi
ok "service restarted"

printf '\n\033[1;32mDeploy complete.\033[0m  Hard-refresh the browser.\n'