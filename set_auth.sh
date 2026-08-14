#!/usr/bin/env bash
# set_auth.sh — set the dashboard username/password.
#
# Usage — run on the Pi (uses the repo venv to bcrypt-hash):
#   ssh pi "bash ~/facts-stats/set_auth.sh <username> <password>"
#
# Hashes the password, writes DASHBOARD_USERNAME / DASHBOARD_PASSWORD_HASH
# into .env, reseeds data/auth.json, and restarts the dashboard.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ "$(uname -s)" = "Darwin" ]; then
  echo "ERROR: this must run on the Pi — the Mac cannot execute the repo's venv."
  echo "       Use: ssh pi 'bash ~/facts-stats/set_auth.sh <username> <password>'"
  exit 1
fi

if [ "$#" -ne 2 ]; then
  echo "Usage: set_auth.sh <username> <password>"
  exit 1
fi
USERNAME="$1"
PASSWORD="$2"
if [ "${#PASSWORD}" -lt 8 ]; then
  echo "ERROR: password must be at least 8 characters"
  exit 1
fi

echo "=== Setting dashboard login: $USERNAME / ******** ==="

"$DIR/venv/bin/python" - "$USERNAME" "$PASSWORD" <<'PY'
import json, os, sys, time
username, password = sys.argv[1], sys.argv[2]

try:
    import bcrypt
except ImportError:
    sys.exit("ERROR: bcrypt not installed in venv")

password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
root = os.getcwd()

# --- Update .env (preserve other keys, keep 0600) ---
env_path = os.path.join(root, ".env")
lines = open(env_path, encoding="utf-8").read().splitlines() if os.path.isfile(env_path) else []

def set_key(key, value):
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.split("=", 1)[0].strip() == key:
            lines[i] = f"{key}={value}"
            return
    lines.append(f"{key}={value}")

set_key("DASHBOARD_USERNAME", username)
set_key("DASHBOARD_PASSWORD_HASH", password_hash)
with open(env_path, "w", encoding="utf-8") as handle:
    handle.write("\n".join(lines) + "\n")
os.chmod(env_path, 0o600)

# --- Reseed data/auth.json (same shape the server writes) ---
auth = {"username": username, "passwordHash": password_hash, "updatedAt": time.time()}
auth_path = os.path.join(root, "data", "auth.json")
os.makedirs(os.path.dirname(auth_path), exist_ok=True)
tmp_path = auth_path + ".tmp"
with open(tmp_path, "w", encoding="utf-8") as handle:
    json.dump(auth, handle, indent=2)
    handle.write("\n")
os.replace(tmp_path, auth_path)
os.chmod(auth_path, 0o600)
print("auth.json + .env updated")
PY

echo "=== Restarting dashboard ==="
if sudo -n systemctl restart facts-dashboard.service 2>/dev/null; then
  echo "Dashboard restarted."
else
  echo "NOTE: could not restart the dashboard (needs sudo). Restart manually:"
  echo "      sudo systemctl restart facts-dashboard.service"
fi

sleep 2
CODE="$(curl -s -o /dev/null -w '%{http_code}' --data-urlencode "username=$USERNAME" --data-urlencode "password=$PASSWORD" http://localhost:12345/login)"
if [ "$CODE" = "302" ]; then
  echo "Login verified: dashboard accepts the new credentials."
else
  echo "Login check returned HTTP $CODE (expected 302). The credentials are set;"
  echo "if this persists, check for login rate-limiting or a cookie issue."
fi
