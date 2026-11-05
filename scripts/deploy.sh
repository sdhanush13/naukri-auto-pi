#!/usr/bin/env bash
# Run on your laptop (Linux/macOS, or Git Bash on Windows). Copies the repo to the Pi over SSH
# and runs install.sh there (rebuild + restart the timer if it is enabled).
#
#   PI=pi@raspberrypi.local bash scripts/deploy.sh            # copy working tree (rsync, or tar if no rsync)
#   PI=pi@raspberrypi.local bash scripts/deploy.sh --git      # instead: git pull in ~/naukri-auto-pi on the Pi
#   PI=... REMOTE_DIR=src/naukri bash scripts/deploy.sh       # different staging dir on the Pi
#
# Personal files (resumes, state.json, artifacts, .env*) are never copied.
set -euo pipefail

PI="${PI:?set PI=user@host of your Raspberry Pi}"
REMOTE_DIR="${REMOTE_DIR:-naukri-auto-pi}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXCLUDES=(.git node_modules dist ms-playwright resumes artifacts state.json '*.cred' '.env*' test-results)

if [ "${1:-}" = "--git" ]; then
  echo "==> git pull on $PI:$REMOTE_DIR"
  ssh "$PI" "cd '$REMOTE_DIR' && git pull --ff-only"
elif command -v rsync >/dev/null; then
  echo "==> rsync to $PI:$REMOTE_DIR"
  args=(); for e in "${EXCLUDES[@]}"; do args+=(--exclude "$e"); done
  rsync -az --delete "${args[@]}" "$ROOT/" "$PI:$REMOTE_DIR/"
else
  echo "==> rsync not found; copying with tar over ssh to $PI:$REMOTE_DIR"
  args=(); for e in "${EXCLUDES[@]}"; do args+=("--exclude=$e"); done
  tar -C "$ROOT" "${args[@]}" -czf - . |
    ssh "$PI" "rm -rf '$REMOTE_DIR.new' && mkdir -p '$REMOTE_DIR.new' && tar -C '$REMOTE_DIR.new' -xzf - && rm -rf '$REMOTE_DIR' && mv '$REMOTE_DIR.new' '$REMOTE_DIR'"
fi

echo "==> install.sh on the Pi (sudo may ask for your password)"
ssh -t "$PI" "sudo bash '$REMOTE_DIR/scripts/install.sh'"
