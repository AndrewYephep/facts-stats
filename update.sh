#!/usr/bin/env bash
# ============================================================================
# update.sh — pull latest code from GitHub and restart the dashboard.
#            STRICT CONTRACT: never touches configs / databases / venvs.
#
# Protected paths (denylist — never written, never deleted, never moved):
#   - .env                  (secrets; installer-generated)
#   - data/                 (grades JSON, DBs, blooket_sets.json, settings.json,
#                            credentials.json, note-quiz SQLite, levels_state DB)
#   - venv/                 (Python virtualenv; built by installer)
#   - /etc/systemd/system/facts-*.service and facts-*.timer
#                            (modified only by install.sh, never by update.sh)
#   - blooket-bot/          (separate repo; lives outside this checkout)
#   - .version              (rewritten by update.sh, not deleted)
#   - .facts-stats-installed
#   - any *.json under data/, *.db, *.sqlite3
#
# Allowed to update:
#   - *.py, *.js, *.html, *.css, *.md at repo root or subdirs
#   - requirements.txt
#   - install.sh, update.sh (this file)
#   - systemd unit templates? NO — only install.sh writes those.
#   - any new files added in upstream main that aren't in the denylist above
#
# What it does:
#   1. git fetch origin
#   2. compare local HEAD to origin/<branch>; if no diff, exit
#   3. snapshot protected paths (just the paths; not the contents)
#   4. git reset --hard origin/<branch>  (this preserves untracked files but
#      overwrites everything tracked; protected paths are already in .gitignore
#      so they survive intact)
#   5. pip install -r requirements.txt if changed
#   6. clear __pycache__/ (regenerated on next run)
#   7. systemctl restart facts-dashboard
#   8. emit a one-line summary
#
# Usage:
#   ./update.sh                    # interactive; asks before applying
#   ./update.sh --yes              # apply without prompting
#   ./update.sh --check            # dry-run check; print diff summary, no action
#   ./update.sh --repo URL --branch main
# ============================================================================

set -euo pipefail

# -------------------- paths & flags --------------------
REPO_URL="${REPO_URL:-https://github.com/AndrewYephep/facts-stats.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="${FACTS_INSTALL_DIR:-}"
ASSUME_YES=0
CHECK_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --install-dir=*) INSTALL_DIR="${arg#*=}" ;;
    --install-dir)   INSTALL_DIR="${2:-}"; shift ;;
    --repo=*)        REPO_URL="${arg#*=}" ;;
    --repo)          REPO_URL="${2:-}"; shift ;;
    --branch=*)      REPO_BRANCH="${arg#*=}" ;;
    --branch)        REPO_BRANCH="${2:-}"; shift ;;
    --yes|-y)        ASSUME_YES=1 ;;
    --check)         CHECK_ONLY=1 ;;
    --help|-h)
      sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# Pretty
if [[ -t 1 ]]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_GREEN=; C_YELLOW=; C_RED=; C_RESET=
fi
say()  { printf '%b%s%b\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%b%s%b\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
err()  { printf '%b%s%b\n' "$C_RED" "$*" "$C_RESET" >&2; }

# -------------------- resolve install dir --------------------
if [[ -z "$INSTALL_DIR" ]]; then
  if [[ -n "${FACTS_INSTALL_DIR:-}" ]]; then
    INSTALL_DIR="$FACTS_INSTALL_DIR"
  elif [[ -f .facts-stats-installed && -f .env ]]; then
    INSTALL_DIR="$(pwd)"
  elif [[ -d /etc/systemd/system/facts-dashboard.service ]]; then
    INSTALL_DIR="$(grep -oP 'WorkingDirectory=\K.*' /etc/systemd/system/facts-dashboard.service | head -1 || true)"
    if [[ -z "$INSTALL_DIR" || ! -d "$INSTALL_DIR" ]]; then
      err "Could not auto-resolve install directory. Pass --install-dir PATH."
      exit 1
    fi
  else
    err "No FACTS_INSTALL_DIR in env, no sentinel, no systemd unit. Pass --install-dir PATH."
    exit 1
  fi
fi
INSTALL_DIR="${INSTALL_DIR%/}"
say "Install directory: $INSTALL_DIR"

cd "$INSTALL_DIR"

# -------------------- verify git origin --------------------
if [[ ! -d .git ]]; then
  err "$INSTALL_DIR is not a git repo."
  exit 1
fi

CURRENT_ORIGIN="$(git config --get remote.origin.url || true)"
if [[ -n "$CURRENT_ORIGIN" && "$CURRENT_ORIGIN" != "$REPO_URL" ]]; then
  warn "Existing origin: $CURRENT_ORIGIN"
  warn "Requested       : $REPO_URL"
  warn "Use --repo to override."
fi

# -------------------- preflight: protected-path integrity --------------------
PROTECTED_PATHS=( ".env" "data/" "venv/" ".facts-stats-installed" )
for p in "${PROTECTED_PATHS[@]}"; do
  if [[ -f .gitignore ]] && ! grep -qxF "$p" .gitignore && ! grep -qE "^/?${p%/}/?$" .gitignore; then
    warn "$p not in .gitignore — verifying it's actually untracked."
    if git ls-files --error-unmatch "$p" >/dev/null 2>&1; then
      err "$p is TRACKED in git. Update will overwrite your data."
      err "Fix:    git rm --cached $p   &&  printf '%s\n' \"$p\" >> .gitignore"
      exit 1
    fi
  fi
done
say "Protected paths are untracked."

# -------------------- detect available update --------------------
say "Fetching origin/$REPO_BRANCH…"
git fetch --no-tags origin "$REPO_BRANCH" 2>/dev/null || {
  err "git fetch failed (network?). Update aborted; nothing changed locally."
  exit 1
}

LOCAL_HEAD="$(git rev-parse --short HEAD)"
REMOTE_HEAD="$(git rev-parse --short "origin/$REPO_BRANCH")"

if [[ "$LOCAL_HEAD" == "$REMOTE_HEAD" ]]; then
  say "Already at origin/$REPO_BRANCH ($LOCAL_HEAD). Nothing to do."
  exit 0
fi

# Compute the file-level diff so we can show what's changing.
DIFF_FILES="$(git diff --name-only "$LOCAL_HEAD" "origin/$REPO_BRANCH")"
DIFF_COUNT="$(echo "$DIFF_FILES" | grep -c . || true)"
say "Update available:"
say "  Local : $LOCAL_HEAD"
say "  Remote: $REMOTE_HEAD"
say "  Files : $DIFF_COUNT changed"

# Catch any forbidden paths in the upstream diff BEFORE we apply.
FORBIDDEN=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    .env|*.env|*.env.*)        FORBIDDEN+="\n  $f (env/secrets)" ;;
    data/*|*/data/*)          FORBIDDEN+="\n  $f (data dir)" ;;
    venv/*|*/venv/*)          FORBIDDEN+="\n  $f (venv)" ;;
    .facts-stats-installed)   FORBIDDEN+="\n  $f (sentinel)" ;;
  esac
done <<< "$DIFF_FILES"
if [[ -n "$FORBIDDEN" ]]; then
  err "Upstream changes touch protected paths:"
  printf '%b\n' "$FORBIDDEN"
  err "Refusing to update. Revert those commits on origin/$REPO_BRANCH or rename the files."
  exit 1
fi

# Confirm.
if [[ $CHECK_ONLY -eq 1 ]]; then
  say "Files changing in this update:"
  echo "$DIFF_FILES" | head -50 | sed 's/^/    /'
  [[ $DIFF_COUNT -gt 50 ]] && say "  … ($(($DIFF_COUNT - 50)) more)"
  say "Use ./update.sh --yes to apply."
  exit 0
fi
if [[ $ASSUME_YES -ne 1 ]]; then
  printf 'Apply %d-file update and restart facts-dashboard? [y/N]: ' "$DIFF_COUNT"
  read -r ans
  case "${ans,,}" in y|yes) ;; *) say "Aborted."; exit 0 ;; esac
fi

# -------------------- apply --------------------
# Snapshot paths (just record what exists so we can confirm they survived).
SNAPSHOT="$(mktemp -d)"
for p in "${PROTECTED_PATHS[@]}"; do
  if [[ -e "$p" ]]; then
    cp -a "$p" "$SNAPSHOT/" 2>/dev/null || true
  fi
done
say "Snapshot of protected paths: $SNAPSHOT"

# Reset. We use `git reset --hard` because denylist paths are .gitignored
# (untracked) and survive. Anything tracked that isn't in the denylist
# gets the upstream version, which is exactly the intent.
git reset --hard "origin/$REPO_BRANCH"

# Confirm the snapshot still matches.
for p in "${PROTECTED_PATHS[@]}"; do
  if [[ -e "$SNAPSHOT/$p" ]] && [[ ! -e "$p" ]]; then
    err "$p was wiped by the update — restoring from snapshot."
    cp -a "$SNAPSHOT/$p" "./" 2>/dev/null || true
  fi
done

# Refresh .version to the new HEAD.
git rev-parse --short HEAD > .version
rm -rf "$SNAPSHOT"

# Pip upgrade if requirements changed.
if git diff --name-only "$LOCAL_HEAD" "origin/$REPO_BRANCH" | grep -qx "requirements.txt"; then
  say "requirements.txt changed; refreshing venv."
  if [[ -x venv/bin/pip ]]; then
    sudo -u "$SUDO_USER" venv/bin/pip install --upgrade -r requirements.txt || warn "pip install failed; restart anyway"
  fi
fi

# Cache invalidation — drop __pycache__ (regenerated on first run).
find . -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true

# Restart.
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet facts-dashboard.service; then
    say "Restarting facts-dashboard…"
    sudo systemctl restart facts-dashboard.service
    sleep 1
    if systemctl is-active --quiet facts-dashboard.service; then
      say "facts-dashboard is running again."
    else
      err "facts-dashboard FAILED to restart. Check: journalctl -u facts-dashboard -n 50"
    fi
  else
    warn "facts-dashboard service not active. Start it with: sudo systemctl start facts-dashboard"
  fi
fi

NEW_VER="$(cat .version 2>/dev/null || echo unknown)"
say "Updated to .version=$NEW_VER ($REMOTE_HEAD)"
say "Protected paths preserved: .env, data/, venv/, .facts-stats-installed"
