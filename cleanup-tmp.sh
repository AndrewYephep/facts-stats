#!/usr/bin/env bash
# Clean stale Chromium/nodriver temp profiles from /tmp.
# Safe to run anytime — only removes tmp.* dirs older than 10 minutes.
set -euo pipefail
find /tmp -maxdepth 1 -name 'tmp.*' -type d -mmin +10 -prune -exec rm -rf {} + 2>/dev/null || true
find /tmp -maxdepth 1 -name 'tmp.*' -type f -mmin +10 -delete 2>/dev/null || true
echo "$(date '+%Y-%m-%d %H:%M:%S') /tmp cleanup: $(df -h /tmp | awk 'NR==2{print $5 " used (" $3 "/" $2 ")"}')"
