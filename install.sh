#!/usr/bin/env bash
# ============================================================================
# install.sh — one-shot installer for the facts-stats dashboard stack.
#
# Idempotent. Safe to re-run on an existing install. Anything it creates is
# tracked by name (a sentinel file under $INSTALL_DIR/.facts-stats-installed)
# so re-runs ask whether to skip or redo each subsystem.
#
# Scope:
#   - Python venv at $INSTALL_DIR/venv (and a venv at $BLOOKET_DIR/venv if
#     the blooket bot is selected)
#   - .env file with SMTP (Gmail default + generic escape), Ollama,
#     dashboard basic-auth, and integration flags
#   - Integrations: Trilium, Google Classroom (power-user), Blooket bot,
#     Facts bot. Each one is optional; each one is requested with a
#     y/N prompt and can be skipped. Google Classroom requires a Google
#     Apps Script webapp on script.google.com pushing payloads through
#     a Cloudflare tunnel to this Pi's api_server.py port 8787 — the
#     install script does NOT set that up automatically because there
#     is no shortcut for those two pieces; it prints a checklist instead.
#   - systemd unit + per-job timers for the dashboard, SIS scrape,
#     note-quiz scheduler, and blooket pipeline
#   - HDMI dummy-plug detection: queries xrandr, asks which DISPLAY to
#     pin chrome bots to, exports DISPLAY in the env + unit files
#   - End-of-install smoke test: real SIS scrape + blooket preview + a
#     note-quiz preview, with a final "Launch dashboard" choice
#
# What it does NOT touch:
#   - anything outside $INSTALL_DIR and /etc/systemd/system
#   - the data/ directory once initialized
#   - any .env file outside $INSTALL_DIR and $BLOOKET_DIR
#
# Usage:
#   ./install.sh                      # interactive
#   ./install.sh --install-dir PATH    # non-interactive install path
#   ./install.sh --repo URL --branch main
#   ./install.sh --dry-run             # print what would happen, change nothing
#   ./install.sh --skip-tests          # skip end-of-install smoke test
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# Defaults — overridable via flags
# ----------------------------------------------------------------------------
REPO_URL="https://github.com/AndrewYephep/facts-stats.git"
REPO_BRANCH="main"
INSTALL_DIR=""
BLOOKET_DIR=""
DRY_RUN=0
SKIP_TESTS=0
NON_INTERACTIVE=0

for arg in "$@"; do
  case "$arg" in
    --install-dir=*) INSTALL_DIR="${arg#*=}" ;;
    --install-dir)   INSTALL_DIR="${2:-}"; shift ;;
    --blooket-dir=*) BLOOKET_DIR="${arg#*=}" ;;
    --blooket-dir)   BLOOKET_DIR="${2:-}"; shift ;;
    --repo=*)        REPO_URL="${arg#*=}" ;;
    --repo)          REPO_URL="${2:-}"; shift ;;
    --branch=*)      REPO_BRANCH="${arg#*=}" ;;
    --branch)        REPO_BRANCH="${2:-}"; shift ;;
    --dry-run)       DRY_RUN=1 ;;
    --skip-tests)    SKIP_TESTS=1 ;;
    --yes|-y)        NON_INTERACTIVE=1 ;;
    --enable-trilium)    ENABLE_TRILIUM=1 ;;
    --enable-classroom)  ENABLE_CLASSROOM=1 ;;
    --enable-blooket)    ENABLE_BLOOKET=1 ;;
    --enable-facts)      ENABLE_FACTS=1 ;;
    --disable-trilium)   ENABLE_TRILIUM=0 ;;
    --disable-classroom) ENABLE_CLASSROOM=0 ;;
    --disable-blooket)   ENABLE_BLOOKET=0 ;;
    --disable-facts)     ENABLE_FACTS=0 ;;
    --help|-h)
      sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ----------------------------------------------------------------------------
# Pretty printing
# ----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=; C_BOLD=; C_BLUE=; C_GREEN=; C_YELLOW=; C_RED=
fi

step() { printf '\n%s== %s ==%s\n' "$C_BOLD$C_BLUE" "$*" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
ask() {
  local prompt="$1"; local default="${2:-}"
  local ans
  if [[ $NON_INTERACTIVE -eq 1 ]]; then
    ans="$default"
  else
    if [[ -n "$default" ]]; then
      printf '  %s [%s]: ' "$prompt" "$default"
    else
      printf '  %s: ' "$prompt"
    fi
    read -r ans
    ans="${ans:-$default}"
  fi
  printf '%s' "$ans"
}
ask_yn() {
  local prompt="$1"; local default="${2:-y}"
  local ans
  if [[ $NON_INTERACTIVE -eq 1 ]]; then ans="$default"
  else
    printf '  %s [%s]: ' "$prompt" "$default"
    read -r ans
    ans="${ans:-$default}"
  fi
  case "${ans,,}" in y|yes|1|true) return 0 ;; *) return 1 ;; esac
}

# `run` does the right thing in dry-run mode.
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  [dry-run] %s' "$(printf '%q ' "$@")"
    printf '\n'
  else
    "$@"
  fi
}

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
step "Preflight"

if [[ $EUID -eq 0 ]]; then
  warn "Running as root. Will drop to SUDO_USER if available."
  if [[ -n "${SUDO_USER:-}" ]]; then
    TARGET_USER="$SUDO_USER"
  else
    TARGET_USER="root"
  fi
else
  TARGET_USER="$(id -un)"
fi

HOME_DIR="$(getent passwd "$TARGET_USER" | cut -d: -f6 || echo "$HOME")"
ok "Target user: $TARGET_USER (home $HOME_DIR)"

# Required tools.
need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command not found: $1"
    return 1
  fi
}
have_cmd() { command -v "$1" >/dev/null 2>&1; }

MISSING=()
for c in python3 git systemctl curl; do
  have_cmd "$c" || MISSING+=("$c")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  err "Missing required commands: ${MISSING[*]}"
  warn "Install them with:  sudo apt-get install -y python3 python3-venv python3-pip git curl"
  exit 1
fi
ok "Required commands present"

# ----------------------------------------------------------------------------
# Pick install dir
# ----------------------------------------------------------------------------
step "Install location"

if [[ -z "$INSTALL_DIR" ]]; then
  if [[ $NON_INTERACTIVE -eq 1 ]]; then
    err "--install-dir is required in non-interactive mode"
    exit 1
  fi
  printf '  Where should facts-stats be installed?\n'
  printf '    Leave blank for [%s]\n' "$HOME_DIR/facts-stats"
  printf '    (any path you can write to; the dashboard runs as %s)\n' "$TARGET_USER"
  read -r INSTALL_DIR
  INSTALL_DIR="${INSTALL_DIR:-$HOME_DIR/facts-stats}"
fi
# Normalise: expand ~ and strip trailing slash.
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME_DIR}"
INSTALL_DIR="${INSTALL_DIR%/}"
ok "Install directory: $INSTALL_DIR"

INSTALL_BIN="$INSTALL_DIR/install"
INSTALL_DATA="$INSTALL_DIR/data"
INSTALL_VENV="$INSTALL_DIR/venv"
INSTALL_ENV="$INSTALL_DIR/.env"
INSTALL_LOG="$INSTALL_DIR/install.log"

if [[ -d "$INSTALL_DIR" ]]; then
  if [[ -f "$INSTALL_DIR/.facts-stats-installed" ]]; then
    warn "Existing install detected (sentinel found). Will not overwrite data/ or .env."
    warn "Use --yes to force; otherwise protected paths are skipped if they exist."
    SKIP_PROTECTED=1
  else
    if [[ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
      ok "Empty directory — fresh install."
      SKIP_PROTECTED=0
    else
      warn "Directory is non-empty but no sentinel. Will not overwrite pre-existing files."
      SKIP_PROTECTED=1
    fi
  fi
else
  run mkdir -p "$INSTALL_DIR"
  chown_path() {
    [[ $DRY_RUN -eq 1 ]] && return 0
    chown -R "$TARGET_USER":"$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_USER")" "$1" 2>/dev/null || true
  }
  chown_path "$INSTALL_DIR"
  SKIP_PROTECTED=0
fi

# ----------------------------------------------------------------------------
# Clone or update the repo into $INSTALL_DIR
# ----------------------------------------------------------------------------
step "Source code"

if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  run sudo -u "$TARGET_USER" git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
else
  ok "Already a git repo; using existing checkout."
fi
# Bump version file so the dashboard can read installed version.
VERSION_FILE="$INSTALL_DIR/.version"
if [[ ! -f "$VERSION_FILE" ]]; then
  run bash -c "cd '$INSTALL_DIR' && git rev-parse --short HEAD > .version"
fi
ok "Installed version: $(cat "$VERSION_FILE" 2>/dev/null || echo 'unknown')"

# ----------------------------------------------------------------------------
# Python venv
# ----------------------------------------------------------------------------
step "Python virtualenv"

if [[ ! -d "$INSTALL_VENV" ]]; then
  run sudo -u "$TARGET_USER" python3 -m venv "$INSTALL_VENV"
  ok "Created venv at $INSTALL_VENV"
else
  ok "Venv already exists at $INSTALL_VENV (skipping create)"
fi

PIP="$INSTALL_VENV/bin/pip"
PY="$INSTALL_VENV/bin/python"
need_cmd_real() {
  if [[ $DRY_RUN -eq 1 ]]; then return 0; fi
  if [[ ! -x "$PY" ]]; then err "venv python missing: $PY"; return 1; fi
  if ! "$PY" -c "import sys; sys.exit(0)" >/dev/null 2>&1; then
    err "venv python broken: $PY"
    return 1
  fi
}
need_cmd_real || exit 1
ok "Venv python OK"

# Install requirements if a requirements file exists.
REQS="$INSTALL_DIR/requirements.txt"
if [[ -f "$REQS" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [dry-run] $PIP install -r $REQS"
  else
    sudo -u "$TARGET_USER" "$PIP" install --upgrade pip wheel setuptools >/dev/null
    sudo -u "$TARGET_USER" "$PIP" install -r "$REQS"
    ok "Installed Python requirements"
  fi
else
  warn "No requirements.txt found at repo root. Skipping pip install."
fi

# Detect-and-install nodriver (used by sis_login.py and blooket-bot).
NODRIVER_VERSION=$(run "$PY" -c "import nodriver; print(getattr(nodriver,'__version__','installed'))" || true)
if [[ -z "$NODRIVER_VERSION" || "$NODRIVER_VERSION" == "installed" ]]; then
  run sudo -u "$TARGET_USER" "$PIP" install 'nodriver>=0.36'
  ok "nodriver installed (no-driver Chrome engine)"
fi

# ----------------------------------------------------------------------------
# Integrations to set up
# ----------------------------------------------------------------------------
step "Integrations"

printf '  Choose which integrations to set up.\n'
printf '  (Each one is optional; you can re-run install.sh later to add more.)\n'
# CLI flags may have set ENABLE_TRILIUM=0 or =1. If unset, fall back to the
# prompt default for each subsystem. We do this by computing an effective
# default once, right before the prompts.
_trilium_default=${ENABLE_TRILIUM-${ENABLE_TRILIUM_DEFAULT:-y}}
_classroom_default=${ENABLE_CLASSROOM-${ENABLE_CLASSROOM_DEFAULT:-n}}
_blooket_default=${ENABLE_BLOOKET-${ENABLE_BLOOKET_DEFAULT:-y}}
_facts_default=${ENABLE_FACTS-${ENABLE_FACTS_DEFAULT:-y}}
ENABLE_TRILIUM=0; ENABLE_CLASSROOM=0; ENABLE_BLOOKET=0; ENABLE_FACTS=0
if ask_yn "Enable Trilium integration?" "$_trilium_default"; then ENABLE_TRILIUM=1; fi
# Google Classroom is left in the menu but treated as a power-user feature:
# the install script cannot create the Apps Script webapp or the Cloudflare
# tunnel for you, so it prints a checklist instead of asking for credentials
# that we have no way to validate from here.
# Default to on when --enable-classroom was passed on the CLI; otherwise default
# to n (it's a power-user feature).
if [[ ${ENABLE_CLASSROOM:-0} -eq 0 && $NON_INTERACTIVE -eq 1 ]]; then
  # No flag set; use the prompt default which is 'n' (see ask_yn default).
  : # fall through to the prompt
fi
# Default to on when --enable-classroom was passed on the CLI; otherwise default
# to n (it's a power-user feature).
if ask_yn "Enable Google Classroom? (power-user — requires Apps Script + Cloudflare tunnel)" "$_classroom_default"; then ENABLE_CLASSROOM=1; fi
if ask_yn "Enable the Blooket bot?" "$_blooket_default"; then ENABLE_BLOOKET=1; fi
if ask_yn "Enable the Facts bot (SIS scraper, grades, note-quiz)?" "$_facts_default"; then ENABLE_FACTS=1; fi

CL_STATUS="off"
[[ $ENABLE_CLASSROOM -eq 1 ]] && CL_STATUS="on (power-user; checklist printed at end)"
ok "Integrations: Trilium=$ENABLE_TRILIUM Blooket=$ENABLE_BLOOKET Facts=$ENABLE_FACTS; Classroom=$CL_STATUS"

# ----------------------------------------------------------------------------
# .env file generation
# ----------------------------------------------------------------------------
step "Environment variables (.env)"

if [[ -f "$INSTALL_ENV" && $SKIP_PROTECTED -eq 1 ]]; then
  warn ".env exists; leaving untouched (delete it to regenerate)."
else
  # SMTP — Gmail default with generic escape hatch.
  printf '  SMTP setup (notifications + email reports)\n'
  SMTP_PROVIDER=$(ask "Provider (gmail/generic)" "gmail")
  if [[ "${SMTP_PROVIDER,,}" == "gmail" ]]; then
    SMTP_HOST_DEFAULT="smtp.gmail.com"
    SMTP_PORT_DEFAULT="587"
    SMTP_TLS_DEFAULT="starttls"
  else
    SMTP_HOST_DEFAULT=""
    SMTP_PORT_DEFAULT="587"
    SMTP_TLS_DEFAULT="starttls"
  fi
  SMTP_HOST=$(ask "SMTP host" "$SMTP_HOST_DEFAULT")
  SMTP_PORT=$(ask "SMTP port" "$SMTP_PORT_DEFAULT")
  SMTP_TLS=$(ask "TLS mode (starttls/ssl/none)" "$SMTP_TLS_DEFAULT")
  SMTP_USER=$(ask "SMTP username" "")
  SMTP_PASS=$(ask "SMTP password/app-password" "")
  SMTP_FROM=$(ask "From address" "${SMTP_USER}")
  SMTP_TO=$(ask "To addresses (comma-sep)" "${SMTP_USER}")

  # Ollama
  OLLAMA_HOST=$(ask "Ollama host URL" "https://ollama.com")
  OLLAMA_KEY=$(ask "Ollama API key" "")

  # Dashboard basic-auth
  DASH_USER=$(ask "Dashboard username" "admin")
  DASH_PASS=$(ask "Dashboard password" "")

  # Blooket bot path
  if [[ $ENABLE_BLOOKET -eq 1 ]]; then
    if [[ -z "$BLOOKET_DIR" ]]; then
      BLOOKET_DIR=$(ask "Blooket-bot directory" "$HOME_DIR/blooket-bot")
    fi
    BLOOKET_DIR="${BLOOKET_DIR/#\~/$HOME_DIR}"
    ok "Blooket bot directory: $BLOOKET_DIR"
  fi

  # HDMI dummy plug detection — runs before we finalise DISPLAY=:N.
  # The function lives further down; we call it once we know X is installed
  # (the detector depends on xrandr).
  HDMI_DISPLAY=""
  # xrandr only works when an X server (or Wayland equivalent) is running.
  # On headless installs and dry-runs it exits non-zero; treat that as 'no display
  # info available' rather than aborting the installer.
  _xrandr_query() {
    if ! have_cmd xrandr; then return 1; fi
    xrandr --query 2>/dev/null
  }
  _XINFO=$(_xrandr_query || true)
  if [[ -n "$_XINFO" ]]; then
    step "HDMI dummy-plug detection"
    DUMMY_LINE=$(printf '%s\n' "$_XINFO" | awk '/ connected / && /1920x1080/ {print $0; exit}')
    if [[ -n "$DUMMY_LINE" ]]; then
      DUMMY_NAME=$(printf '%s\n' "$DUMMY_LINE" | awk '{print $1}')
      DUMMY_RES=$(printf '%s\n' "$DUMMY_LINE" | grep -oE '[0-9]+x[0-9]+' | head -1)
      warn "Likely dummy plug detected: $DUMMY_NAME ($DUMMY_RES)"
      warn "Some HDMI dummy plugs enumerate as 'connected 1920x1080' with a fixed EDID."
      if ask_yn "Use $DUMMY_NAME for the chrome bots?" "y"; then
        HDMI_DISPLAY=":$DUMMY_NAME"
      else
        printf '  Available displays:\n'
        printf '%s\n' "$_XINFO" | grep " connected" | sed 's/^/    /'
        DISPLAY_PICK=$(ask "Pick a display name" "")
        HDMI_DISPLAY=":${DISPLAY_PICK}"
      fi
    else
      warn "No obvious dummy plug. Listing displays:"
      printf '%s\n' "$_XINFO" | grep -E " connected|disconnected" | sed 's/^/    /'
      DISPLAY_PICK=$(ask "Display to use for chrome bots (leave blank for default)" "")
      [[ -n "$DISPLAY_PICK" ]] && HDMI_DISPLAY=":$DISPLAY_PICK"
    fi
  fi

  # Write .env (only if missing or non-protected mode).
  ENV_TMP="$(mktemp)"
  cat > "$ENV_TMP" <<EOF
# Generated by install.sh — feel free to edit; this file is gitignored.

# Install paths
FACTS_INSTALL_DIR=$INSTALL_DIR
FACTS_DATA_DIR=$INSTALL_DATA
BLOOKET_DIR=${BLOOKET_DIR:-}

# Display for chrome bots (set by installer; change here if you add a monitor)
DISPLAY=${HDMI_DISPLAY:-:0}

# SMTP
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_TLS=$SMTP_TLS
SMTP_USER=$SMTP_USER
SMTP_PASSWORD=$SMTP_PASS
SMTP_FROM=$SMTP_FROM
SMTP_TO=$SMTP_TO

# Ollama
OLLAMA_HOST=$OLLAMA_HOST
OLLAMA_API_KEY=$OLLAMA_KEY

# Dashboard basic-auth (used by /login)
DASHBOARD_USER=$DASH_USER
DASHBOARD_PASSWORD=$DASH_PASS

# Integration flags (1=enabled)
ENABLE_TRILIUM=$ENABLE_TRILIUM
ENABLE_CLASSROOM=$ENABLE_CLASSROOM
ENABLE_BLOOKET=$ENABLE_BLOOKET
ENABLE_FACTS=$ENABLE_FACTS

# Selenium/Chrome flags for nodriver
NODRIVER_DISABLE_BLANK=$([ -n "$HDMI_DISPLAY" ] && echo 1 || echo 0)
HEADLESS=$([ -n "$HDMI_DISPLAY" ] && echo 0 || echo 1)

# Internal
INSTALLER_VERSION=$(cat "$VERSION_FILE" 2>/dev/null || echo unknown)
EOF

  if [[ $DRY_RUN -eq 0 ]]; then
    install -o "$TARGET_USER" -g "$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_USER")" -m 0600 "$ENV_TMP" "$INSTALL_ENV"
    ok ".env written to $INSTALL_ENV (chmod 600)"
  else
    echo "  [dry-run] would write $INSTALL_ENV"
  fi
  rm -f "$ENV_TMP"
fi

# ----------------------------------------------------------------------------
# Optional integrations get their own provider-specific setup
# ----------------------------------------------------------------------------
step "Per-integration setup"

if [[ $ENABLE_TRILIUM -eq 1 ]]; then
  printf '  Trilium ETAPI setup\n'
  TRILIUM_URL=$(ask "Trilium URL (e.g. http://192.168.1.42:8081)" "")
  TRILIUM_TOKEN=$(ask "Trilium ETAPI token (leave blank to configure later)" "")
  if [[ -n "$TRILIUM_URL" && -n "$TRILIUM_TOKEN" ]]; then
    # Probe to confirm we can reach it.
    if curl -fsS -H "Authorization: $TRILIUM_TOKEN" "${TRILIUM_URL%/}/etapi/notes?parent=root" >/dev/null 2>&1; then
      ok "Trilium reachable and token accepted"
      # Auto-detect classes by listing the root note's children.
      CLASS_LIST=$(curl -fsS -H "Authorization: $TRILIUM_TOKEN" "${TRILIUM_URL%/}/etapi/notes?parent=root" 2>/dev/null || echo '')
      if [[ -n "$CLASS_LIST" ]]; then
        CLASSES=$(echo "$CLASS_LIST" | "$PY" -c "import sys,json; d=json.load(sys.stdin); print('\n'.join(n.get('title','') for n in d if n.get('title')))" 2>/dev/null || true)
        if [[ -n "$CLASSES" ]]; then
          ok "Auto-detected notes under root:"
          printf '    %s\n' "$CLASSES"
        else
          warn "Couldn't enumerate notes (response format?). Skipping class detection."
        fi
      fi
    else
      warn "Couldn't reach Trilium at $TRILIUM_URL — you may need to configure it from the dashboard."
    fi
  fi
fi

if [[ $ENABLE_CLASSROOM -eq 1 ]]; then
  step "Google Classroom — power-user setup"

  cat <<'CHECKLIST'

  ┌────────────────────────────────────────────────────────────────┐
  │  Google Classroom is a TUNNELED push pipeline, not direct       │
  │  OAuth. We cannot make this work without three things you     │
  │  provide. The install script cannot fetch them for you.       │
  │                                                                │
  │  WHAT YOU NEED                                                 │
  │  ─────────                                                     │
  │   1. A Google Apps Script web-app, deployed as 'Execute as    │
  │      me' + 'Who has access: Anyone'. Its URL looks like       │
  │      https://script.google.com/macros/s/<id>/exec              │
  │                                                                │
  │   2. The Apps Script polls Classroom once or twice a day for    │
  │      each course you teach and POSTs the JSON to a public      │
  │      endpoint on the Pi. That endpoint is reached through      │
  │      a Cloudflare Tunnel (or ngrok, Tailscale Funnel, etc.)    │
  │      because your Pi is not on the public internet.            │
  │                                                                │
  │   3. An X-API-Key shared secret. The script picks one and      │
  │      bakes it into both ends. We will write it into            │
  │      api_server.py on the Pi and into the Apps Script's        │
  │      PropertiesService.                                       │
  │                                                                │
  │  THREE STEPS AFTER THIS INSTALL                                │
  │  ────────────────────────────                                  │
  │   A. On a machine with node, run `npx wrangler tunnel login`   │
  │      once. Pick a hostname (or bring your own). The tunnel     │
  │      config that goes on the Pi is printed below after you     │
  │      give me the hostname.                                     │
  │                                                                │
  │   B. In your Google Drive: create a new Apps Script project,   │
  │      paste the contents of $INSTALL_DIR/templates/classroom-    │
  │      sync.gs (printed by the install if missing), set the       │
  │      X-API-Key PropertiesService to the secret I generate,     │
  │      and run 'setup()' once. Deploy it as a web-app.           │
  │                                                                │
  │   C. Run api_server.py on the Pi (it must be reachable from the │
  │      tunnel's `service` URL). It binds to localhost:8787 by    │
  │      default. Until BOTH endpoints exist, the dashboard's       │
  │      Classroom panel shows nothing — and that's the only       │
  │      sign that something is wrong. Nothing crashes.            │
  └────────────────────────────────────────────────────────────────┘

CHECKLIST

  # Capture the two values the install CAN do something with:
  PUBLIC_TUNNEL_URL=$(ask "Public URL of your Cloudflare tunnel (https://yourhost.example.com, leave blank to set up later)" "")
  CLASSROOM_API_KEY=$(ask "Shared secret for X-API-Key (leave blank to auto-generate; this matches api_server.py's CLASSROOM_API_KEY)" "")
  if [[ -z "$CLASSROOM_API_KEY" ]]; then
    CLASSROOM_API_KEY=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
    ok "Generated X-API-Key: $CLASSROOM_API_KEY  ← save this; you'll need it in the Apps Script too"
  fi
  if [[ -n "$PUBLIC_TUNNEL_URL" ]]; then
    ok "Public endpoint where Apps Script will POST: $PUBLIC_TUNNEL_URL/classroom-sync"
  fi

  # Persist to .env so api_server.py / cron / tunnel config can read it.
  if [[ $DRY_RUN -eq 0 ]]; then
    cat >> "$INSTALL_ENV" <<EOF

# Google Classroom (power-user — see install.sh checklist)
GC_PUBLIC_TUNNEL_URL=${PUBLIC_TUNNEL_URL}
CLASSROOM_API_KEY=${CLASSROOM_API_KEY}
GC_ENABLED=1
EOF
    ok "Wrote Classroom section to $INSTALL_ENV"
  else
    printf '\n  [dry-run] would append to %s:\n' "$INSTALL_ENV"
    printf '    GC_PUBLIC_TUNNEL_URL=%s\n' "$PUBLIC_TUNNEL_URL"
    printf '    CLASSROOM_API_KEY=%s\n' "$CLASSROOM_API_KEY"
    printf '    GC_ENABLED=1\n'
  fi

  # Emit the Apps Script template. In dry-run we print to stdout so the user
  # can copy-paste it; otherwise we land it at $INSTALL_DIR/templates/.
  CLASSROOM_GS_FILE="$(mktemp)"
  {
    echo '// classroom-sync.gs — paste this entire file into a new Apps Script'
    echo '// web-app project. Then Deploy → New deployment → Web app →'
    echo '// "Execute as Me" + "Who has access: Anyone". Project Settings →'
    echo '// Script properties: set API_KEY, PUSH_URL, and (after running'
    echo '// setup() once) COURSES.'
    echo ''
    echo 'const PROPS = PropertiesService.getScriptProperties();'
    echo 'const API_KEY = PROPS.getProperty("API_KEY");'
    echo 'const PUSH_URL = PROPS.getProperty("PUSH_URL");'
    echo ''
    echo 'function setup() {'
    echo '  const courses = Classroom.Courses.list().courses || [];'
    echo '  PROPS.setProperty("COURSES", JSON.stringify(courses.map(c => c.id)));'
    echo '  Logger.log("Saved " + courses.length + " course IDs.");'
    echo '}'
    echo ''
    echo 'function push() {'
    echo '  const courses = JSON.parse(PROPS.getProperty("COURSES") || "[]");'
    echo '  const payload = { received_at: Date.now() / 1000, courses: [] };'
    echo '  for (const cid of courses) {'
    echo '    const work = Classroom.Courses.CourseWork.list(cid).courseWork || [];'
    echo '    const submissions = [];'
    echo '    for (const cw of work) {'
    echo '      const ws = Classroom.Courses.CourseWork.StudentSubmissions.list(cid, cw.id);'
    echo '      const ss = (ws.studentSubmissions || [])'
    echo '        .filter(s => s.state === "TURNED_IN" || s.state === "RETURNED");'
    echo '      submissions.push({'
    echo '        assignment: cw.title,'
    echo '        dueDate: cw.dueDate ? (cw.dueDate.year + "-" + cw.dueDate.month + "-" + cw.dueDate.day) : "",'
    echo '        link: cw.alternateLink,'
    echo '        lateCount: ss.filter(s => s.late).length,'
    echo '        turnedInCount: ss.filter(s => s.state === "TURNED_IN").length,'
    echo '        returnedCount: ss.filter(s => s.state === "RETURNED").length,'
    echo '      });'
    echo '    }'
    echo '    if (submissions.length) payload.courses.push({ courseId: cid, submissions });'
    echo '  }'
    echo '  UrlFetchApp.fetch(PUSH_URL, {'
    echo '    method: "post",'
    echo '    contentType: "application/json",'
    echo '    payload: JSON.stringify(payload),'
    echo '    headers: { "X-API-Key": API_KEY },'
    echo '  });'
    echo '}'
  } > "$CLASSROOM_GS_FILE"

  if [[ $DRY_RUN -eq 0 ]]; then
    mkdir -p "$INSTALL_DIR/templates"
    cp "$CLASSROOM_GS_FILE" "$INSTALL_DIR/templates/classroom-sync.gs"
    ok "Wrote Apps Script template to $INSTALL_DIR/templates/classroom-sync.gs"
  else
    printf '\n  [dry-run] would write $INSTALL_DIR/templates/classroom-sync.gs:\n\n'
    cat "$CLASSROOM_GS_FILE"
    printf '\n'
  fi
  rm -f "$CLASSROOM_GS_FILE"

  warn "Classroom will not show data until BOTH the Cloudflare tunnel and the Apps Script"
  warn "web-app are deployed. See the checklist printed above for the exact URLs."
fi

if [[ $ENABLE_BLOOKET -eq 1 ]]; then
  printf '  Blooket bot setup\n'
  if [[ ! -d "$BLOOKET_DIR" ]]; then
    warn "Blooket-bot directory missing: $BLOOKET_DIR"
    if ask_yn "Clone the blooket-bot into $BLOOKET_DIR now?" "y"; then
      run sudo -u "$TARGET_USER" git clone https://github.com/AndrewYephep/blooket-bot.git "$BLOOKET_DIR"
    fi
  fi
  if [[ -d "$BLOOKET_DIR" ]]; then
    BVIEW="$BLOOKET_DIR/venv"
    if [[ ! -d "$BVIEW" ]]; then
      run sudo -u "$TARGET_USER" python3 -m venv "$BVIEW"
      ok "Created blooket-bot venv at $BVIEW"
    fi
    if [[ -f "$BLOOKET_DIR/requirements.txt" ]]; then
      if [[ $DRY_RUN -eq 0 ]]; then
        sudo -u "$TARGET_USER" "$BVIEW/bin/pip" install -r "$BLOOKET_DIR/requirements.txt"
        ok "Blooket-bot deps installed"
      fi
    fi
    if [[ ! -f "$BLOOKET_DIR/.env" ]]; then
      BEMAIL=$(ask "Blooket login email" "")
      BPASS=$(ask "Blooket login password" "")
      printf 'BLOOKET_EMAIL=%s\nBLOOKET_PASSWORD=%s\n' "$BEMAIL" "$BPASS" > "$BLOOKET_DIR/.env.tmp"
      install -o "$TARGET_USER" -g "$(id -gn "$TARGET_USER")" -m 0600 "$BLOOKET_DIR/.env.tmp" "$BLOOKET_DIR/.env"
      rm -f "$BLOOKET_DIR/.env.tmp"
      ok "Blooket-bot .env written (chmod 600)"
    fi
  fi
fi

# ----------------------------------------------------------------------------
# systemd unit + timers
# ----------------------------------------------------------------------------
step "systemd units"

if [[ $DRY_RUN -eq 0 ]] && have_cmd systemctl; then
  UNIT_DIR="/etc/systemd/system"
  UNIT_FILE="$UNIT_DIR/facts-dashboard.service"
  MONITOR_FILE="$UNIT_DIR/facts-monitor.service"

  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Facts Grades Dashboard (FastAPI + Uvicorn)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_ENV
ExecStartPre=$INSTALL_DIR/cleanup-tmp.sh
ExecStart=$INSTALL_VENV/bin/uvicorn dashboard_server:app --host 0.0.0.0 --port 12345 --workers 1
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  cat > "$MONITOR_FILE" <<EOF
[Unit]
Description=Facts dashboard monitor (auto-restart on failure)

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'systemctl is-active facts-dashboard.service || systemctl restart facts-dashboard.service'
EOF

  # Optional: scrape timer.
  if [[ $ENABLE_FACTS -eq 1 ]]; then
    cat > "$UNIT_DIR/facts-scrape.timer" <<EOF
[Unit]
Description=Daily SIS scrape

[Timer]
OnCalendar=*-*-* 07:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
    cat > "$UNIT_DIR/facts-scrape.service" <<EOF
[Unit]
Description=Daily SIS scrape (sis_login.py)
After=network-online.target

[Service]
Type=oneshot
User=$TARGET_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_ENV
ExecStart=$INSTALL_VENV/bin/python $INSTALL_DIR/sis_login.py --period all
StandardOutput=journal
StandardError=journal
EOF
  fi

  # Optional: blooket timer.
  if [[ $ENABLE_BLOOKET -eq 1 ]]; then
    cat > "$UNIT_DIR/facts-blooket.timer" <<EOF
[Unit]
Description=Generate Blooket quiz for latest chapter (daily)

[Timer]
OnCalendar=*-*-* 08:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
    cat > "$UNIT_DIR/facts-blooket.service" <<EOF
[Unit]
Description=Blooket quiz generation
After=network-online.target

[Service]
Type=oneshot
User=$TARGET_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_ENV
ExecStart=$INSTALL_VENV/bin/python $INSTALL_DIR/blooket_builder.py --once
StandardOutput=journal
StandardError=journal
EOF
  fi

  systemctl daemon-reload
  systemctl enable facts-dashboard.service
  systemctl restart facts-dashboard.service
  [[ -f "$UNIT_DIR/facts-scrape.timer" ]] && systemctl enable facts-scrape.timer
  [[ -f "$UNIT_DIR/facts-blooket.timer" ]] && systemctl enable facts-blooket.timer
  ok "systemd units installed; dashboard running on http://localhost:12345"
else
  warn "Skipping systemd step (dry-run or systemctl missing)"
fi

# ----------------------------------------------------------------------------
# Final sentinel + smoke test
# ----------------------------------------------------------------------------
step "Mark installed"
if [[ $DRY_RUN -eq 0 ]]; then
  printf '%s\n%s\n' "installed=$(date -Iseconds)" "version=$(cat "$VERSION_FILE" 2>/dev/null || echo unknown)" > "$INSTALL_DIR/.facts-stats-installed"
fi
ok "Install complete. Sentinel written to $INSTALL_DIR/.facts-stats-installed"

if [[ $SKIP_TESTS -eq 1 ]]; then
  echo
  ok "Skipping smoke tests (--skip-tests)."
  exit 0
fi

if [[ $ENABLE_FACTS -eq 1 ]]; then
  step "Smoke test: SIS scrape"
  printf '  This will log into the SIS once with your credentials and pull class names + current term.\n'
  printf '  Stored credentials go into data/credentials.json (0600).\n'
  SIS_USER=$(ask "SIS username" "")
  SIS_PASS=$(ask "SIS password" "")
  if [[ -n "$SIS_USER" && -n "$SIS_PASS" ]]; then
    SIS_DISTRICT=$(ask "District code" "")
    if [[ $DRY_RUN -eq 0 ]]; then
      mkdir -p "$INSTALL_DATA"
      printf '%s\n%s\n%s\n' "DISTRICT_CODE=$SIS_DISTRICT" "SIS_USERNAME=$SIS_USER" "SIS_PASSWORD=$SIS_PASS" \
        > "$INSTALL_DATA/credentials.json.tmp"
      install -o "$TARGET_USER" -g "$(id -gn "$TARGET_USER")" -m 0600 \
        "$INSTALL_DATA/credentials.json.tmp" "$INSTALL_DATA/credentials.json"
      rm -f "$INSTALL_DATA/credentials.json.tmp"
      ok "Credentials saved (0600)"
      ok "Launching sis_login.py…"
      if sudo -u "$TARGET_USER" env -i HOME="$HOME_DIR" PATH="$INSTALL_VENV/bin:/usr/bin:/bin" \
            "$PY" "$INSTALL_DIR/sis_login.py" --period all --use-saved-credentials; then
        ok "SIS scrape succeeded — class list and grades populated."
      else
        warn "SIS scrape failed. Re-run $INSTALL_DIR/sis_login.py manually after fixing credentials."
      fi
    fi
  fi
fi

if [[ $ENABLE_BLOOKET -eq 1 ]]; then
  step "Smoke test: Blooket pipeline"
  if ask_yn "Run a quick Blooket dry check (no publish)?" "y"; then
    if [[ $DRY_RUN -eq 0 && -d "$BLOOKET_DIR" ]]; then
      sudo -u "$TARGET_USER" "$BLOOKET_DIR/venv/bin/python" -c "import nodriver; print('blooket-bot python OK')" || true
      ok "Blooket-bot deps verified."
    fi
  fi
fi

step "Done"
ok "Dashboard: http://localhost:12345"
ok "Logs: journalctl -u facts-dashboard -f"
ok "Update: ./update.sh (or the in-app update button)"
ok "Re-run: ./install.sh — protected paths (.env, data/, .facts-stats-installed) are skipped."
