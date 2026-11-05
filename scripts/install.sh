#!/usr/bin/env bash
# Install or update naukri-refresher on the Raspberry Pi. Safe to re-run (deploy.sh does).
#
#   sudo bash scripts/install.sh                  # Docker mode (default)
#   sudo bash scripts/install.sh --mode native    # Node + Chromium directly on the Pi
#   sudo bash scripts/install.sh --enable         # also enable + start the timer
#
# The mode is remembered in /etc/naukri-refresher/mode, so later re-runs keep it.
set -euo pipefail

APP_DIR=/opt/naukri-refresher
ETC_DIR=/etc/naukri-refresher
STATE_DIR=/var/lib/naukri-refresher
UNIT_DIR=/etc/systemd/system
SVC=naukri-refresher.service
TIMER=naukri-refresher.timer
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

MODE=""
ENABLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
[ -z "$MODE" ] && [ -f "$ETC_DIR/mode" ] && MODE="$(cat "$ETC_DIR/mode")"
MODE="${MODE:-docker}"
[ "$MODE" = docker ] || [ "$MODE" = native ] || die "--mode must be docker or native"

[ "$(id -u)" -eq 0 ] || die "run with sudo"
arch="$(uname -m)"
[ "$arch" = aarch64 ] || die "64-bit OS required: uname -m says '$arch', expected 'aarch64'. Install 64-bit Raspberry Pi OS."
command -v systemd-creds >/dev/null || die "systemd-creds missing (need systemd >= 250)"
command -v python3 >/dev/null || die "python3 missing (used to read the schedule from config.json)"

info "mode: $MODE"

# --- user -------------------------------------------------------------------------------------
if ! id naukri >/dev/null 2>&1; then
  info "creating system user naukri (no login shell)"
  useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin naukri
fi

# --- directories ------------------------------------------------------------------------------
install -d -m 0750 -o root -g naukri "$ETC_DIR" "$ETC_DIR/resume"
install -d -m 0700 -o root -g root "$ETC_DIR/creds"
install -d -m 0700 -o naukri -g naukri "$STATE_DIR" "$STATE_DIR/artifacts"
[ -f "$STATE_DIR/state.json" ] && chown naukri:naukri "$STATE_DIR/state.json" && chmod 0600 "$STATE_DIR/state.json"
echo "$MODE" >"$ETC_DIR/mode"

if [ ! -f "$ETC_DIR/config.json" ]; then
  install -m 0640 -o root -g naukri "$SRC_DIR/config.example.json" "$ETC_DIR/config.json"
  info "created $ETC_DIR/config.json from the example - EDIT IT before the first run"
else
  chown root:naukri "$ETC_DIR/config.json"; chmod 0640 "$ETC_DIR/config.json"
fi
find "$ETC_DIR/resume" -type f -exec chown root:naukri {} + -exec chmod 0640 {} +

# --- application files ------------------------------------------------------------------------
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  info "copying app to $APP_DIR"
  install -d -m 0755 "$APP_DIR"
  # Keep previously installed node_modules / browsers (native mode) to avoid re-downloading.
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name ms-playwright -exec rm -rf {} +
  tar -C "$SRC_DIR" \
    --exclude=./.git --exclude=./node_modules --exclude=./dist --exclude=./ms-playwright \
    --exclude=./state.json --exclude=./artifacts --exclude=./resumes --exclude='./.env*' \
    -cf - . | tar -C "$APP_DIR" --no-same-owner -xf -
fi
chown -R root:root "$APP_DIR"
chmod -R u=rwX,go=rX "$APP_DIR"

# --- runtime ----------------------------------------------------------------------------------
if [ "$MODE" = docker ]; then
  command -v docker >/dev/null || die "Docker not installed. Install it (https://docs.docker.com/engine/install/debian/), then re-run."
  info "building image naukri-refresher:latest (pulls the arm64 Playwright base image)"
  docker build --pull -t naukri-refresher:latest "$APP_DIR"
  docker image prune -f >/dev/null || true
  install -m 0644 "$APP_DIR/systemd/naukri-refresher.service" "$UNIT_DIR/$SVC"
else
  command -v node >/dev/null || die "Node.js not installed. Install Node 22 LTS (NodeSource or nvm for root), then re-run."
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 20 ] || die "Node >= 20 required, found $(node -v)"
  info "installing npm dependencies and building"
  cd "$APP_DIR"
  npm ci --no-audit --no-fund
  npm run build
  info "installing Xvfb (virtual display for browserMode \"headed\")"
  apt-get install -y --no-install-recommends xvfb xauth >/dev/null
  info "installing Chromium (arm64) + system libraries"
  PLAYWRIGHT_BROWSERS_PATH="$APP_DIR/ms-playwright" npx playwright install --with-deps chromium \
    || die "Playwright could not install Chromium for this OS/arch; use --mode docker"
  npm prune --omit=dev --no-audit --no-fund
  chmod -R u=rwX,go=rX "$APP_DIR"
  install -m 0644 "$APP_DIR/systemd/naukri-refresher.native.service" "$UNIT_DIR/$SVC"
fi

# --- timer + schedule -------------------------------------------------------------------------
install -m 0644 "$APP_DIR/systemd/naukri-refresher.timer" "$UNIT_DIR/$TIMER"
schedule="$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("schedule","Mon..Fri 10:00"))
except Exception: print("Mon..Fri 10:00")' "$ETC_DIR/config.json")"
systemd-analyze calendar "$schedule" >/dev/null || die "invalid schedule '$schedule' in config.json (systemd OnCalendar syntax)"
install -d -m 0755 "$UNIT_DIR/$TIMER.d"
printf '[Timer]\nOnCalendar=\nOnCalendar=%s\n' "$schedule" >"$UNIT_DIR/$TIMER.d/schedule.conf"
info "schedule: $schedule"

# Regenerate the credentials drop-in from whatever *.cred files exist.
bash "$APP_DIR/scripts/set-credentials.sh" sync >/dev/null

# Calendar timers wait for time-sync.target; the Pi has no RTC, so make that target meaningful.
if systemctl list-unit-files systemd-time-wait-sync.service >/dev/null 2>&1; then
  systemctl enable systemd-time-wait-sync.service >/dev/null 2>&1 || true
fi

systemctl daemon-reload
if [ "$ENABLE" = 1 ]; then
  systemctl enable --now "$TIMER"
  info "timer enabled"
elif systemctl is-enabled --quiet "$TIMER" 2>/dev/null; then
  systemctl restart "$TIMER"
  info "timer restarted"
else
  info "timer NOT enabled yet. After a successful dry run: sudo systemctl enable --now $TIMER"
fi

missing=()
[ -f "$ETC_DIR/creds/naukri-password.cred" ] || missing+=("credentials: sudo bash $APP_DIR/scripts/set-credentials.sh")
[ -f "$STATE_DIR/state.json" ] || missing+=("session: npm run manual-login on your laptop, then copy state.json (README)")
ls "$ETC_DIR/resume/"* >/dev/null 2>&1 || missing+=("resume: copy it into $ETC_DIR/resume/ and set resumePath")
if [ ${#missing[@]} -gt 0 ]; then
  echo; echo "Still to do:"; printf '  - %s\n' "${missing[@]}"
fi
info "done"
