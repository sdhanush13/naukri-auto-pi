#!/usr/bin/env bash
# Start the service now and follow its log. Run on the Pi.
#
#   bash scripts/run-now.sh             # real run (counts toward the 2-attempts-per-day cap)
#   bash scripts/run-now.sh --dry-run   # restore session / log in, screenshot, change nothing
set -euo pipefail
UNIT=naukri-refresher.service
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO=sudo

if [ "${1:-}" = "--dry-run" ]; then
  echo "NAUKRI_DRY_RUN=1" | $SUDO tee /run/naukri-refresher.oneshot.env >/dev/null
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
