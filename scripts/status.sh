#!/usr/bin/env bash
# Last run result, next scheduled run, newest artifacts. Run on the Pi.
set -uo pipefail
UNIT=naukri-refresher.service
STATE_DIR=/var/lib/naukri-refresher
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO=sudo

echo "== Last run"
if $SUDO test -f "$STATE_DIR/last-run.json"; then
  $SUDO python3 - "$STATE_DIR/last-run.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print(f"  finished : {r.get('finishedAt')}{'  (dry run)' if r.get('dryRun') else ''}")
print(f"  result   : exit {r.get('code')} - {r.get('outcome')}")
if r.get('step'): print(f"  step     : {r['step']}")
print(f"  attempts : {r.get('attempts')}")
print(f"  message  : {r.get('message')}")
PY
else
  echo "  no runs recorded yet"
fi
echo "  systemd  : $(systemctl show -p Result --value $UNIT), exit status $(systemctl show -p ExecMainStatus --value $UNIT)"

echo
echo "== Schedule"
systemctl list-timers naukri-refresher.timer naukri-apply.timer --all --no-pager | cat
echo "  refresh timer enabled: $(systemctl is-enabled naukri-refresher.timer 2>/dev/null || true)"
echo "  apply timer enabled:   $(systemctl is-enabled naukri-apply.timer 2>/dev/null || true)"

echo
echo "== Auto-apply (today)"
if $SUDO test -f "$STATE_DIR/apply-history.json"; then
  $SUDO python3 - "$STATE_DIR/apply-history.json" <<'PY'
import json, sys, collections
h = json.load(open(sys.argv[1]))
d = h.get("daily", {})
print(f"  applied on {d.get('date')}: {d.get('applied', 0)}")
c = collections.Counter(j["status"] for j in h.get("jobs", {}).values())
print("  all jobs seen: " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
PY
else
  echo "  no apply runs yet"
fi

echo
echo "== Last 3 artifacts ($STATE_DIR/artifacts)"
$SUDO sh -c "ls -1dt $STATE_DIR/artifacts/*/ 2>/dev/null | head -3" | while read -r d; do
  echo "  $d  ($($SUDO ls "$d" | tr '\n' ' '))"
done
[ -n "$($SUDO sh -c "ls -A $STATE_DIR/artifacts 2>/dev/null")" ] || echo "  none"

echo
echo "== Session"
if $SUDO test -f "$STATE_DIR/state.json"; then
  echo "  state.json saved $($SUDO stat -c %y "$STATE_DIR/state.json" | cut -d. -f1)"
else
  echo "  no state.json - run manual-login (README)"
fi
