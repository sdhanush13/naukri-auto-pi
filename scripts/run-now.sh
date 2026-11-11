#!/usr/bin/env bash
# Start a service now and follow its log. Run on the Pi.
#
#   bash scripts/run-now.sh                    # profile refresh (counts toward maxAttemptsPerDay)
#   bash scripts/run-now.sh --dry-run          # restore session / log in, screenshot, change nothing
#   bash scripts/run-now.sh --apply            # auto-apply (dry run until apply.autoFrom)
#   bash scripts/run-now.sh --apply --dry-run  # auto-apply, forced dry run: report only
set -euo pipefail
UNIT=naukri-refresher.service
ENVFILE=/run/naukri-refresher.oneshot.env
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --apply) UNIT=naukri-apply.service; ENVFILE=/run/naukri-apply.oneshot.env ;;
    *) echo "unknown option $arg" >&2; exit 64 ;;
  esac
done
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO=sudo

if [ "$DRY" = 1 ]; then
  echo "NAUKRI_DRY_RUN=1" | $SUDO tee "$ENVFILE" >/dev/null
  echo "==> dry run"
fi

$SUDO journalctl -u "$UNIT" -f -n 0 -o cat &
JPID=$!
trap 'kill $JPID 2>/dev/null || true' EXIT

if $SUDO systemctl start "$UNIT"; then
  code=0
else
  code="$(systemctl show -p ExecMainStatus --value "$UNIT")"
fi
sleep 1 # let journalctl flush the last lines
case "$code" in
  0) echo "==> success" ;;
  2) echo "==> exit 2: manual login needed - see README 'Recovering from exit code 2'" ;;
  *) echo "==> failed (exit $code) - see: bash scripts/status.sh" ;;
esac
exit "$code"
