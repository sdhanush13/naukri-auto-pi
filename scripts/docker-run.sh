#!/usr/bin/env bash
# Called by naukri-refresher.service (Docker mode). Do not run by hand; use scripts/run-now.sh.
#
# systemd has decrypted the credentials into $CREDENTIALS_DIRECTORY (root-only ramfs).
# The container runs as the unprivileged naukri UID, so we copy them into this unit's
# private RuntimeDirectory (tmpfs, removed automatically when the unit stops), chown them
# to naukri, and mount that copy read-only. Secrets never go into env vars or the image.
set -euo pipefail

: "${CREDENTIALS_DIRECTORY:?no credentials loaded; run scripts/set-credentials.sh}"
: "${RUNTIME_DIRECTORY:?must run under systemd (RuntimeDirectory=)}"
IMAGE="${NAUKRI_IMAGE:-naukri-refresher:latest}"
# Set by the unit: naukri-refresher.service runs the refresh, naukri-apply.service the auto-apply
# (on the naukri-net network, where the local model container naukri-ollama lives).
TASK="${NAUKRI_TASK:-refresh}"
NETWORK="${NAUKRI_NETWORK:-bridge}"
NAME="naukri-refresher"; [ "$TASK" = refresh ] || NAME="naukri-$TASK"

uid="$(id -u naukri)"
gid="$(id -g naukri)"

# The unit drops CAP_DAC_OVERRIDE, so root here obeys normal file permissions: fill the
# directory while root still owns it, and only then hand it to naukri (CAP_CHOWN/CAP_FOWNER).
# RuntimeDirectory= is created empty for every run and removed afterwards.
creds="${RUNTIME_DIRECTORY}/creds"
install -d -m 0700 "$creds"
for f in "$CREDENTIALS_DIRECTORY"/*; do
  [ -e "$f" ] || continue
  install -m 0400 -o "$uid" -g "$gid" "$f" "$creds/$(basename "$f")"
done
chown "$uid:$gid" "$creds"
chmod 0500 "$creds"
mkdir -p "${DOCKER_CONFIG:-$RUNTIME_DIRECTORY/docker}"

tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"

# Exit status of `docker run` is the container's exit code (0/1/2), which systemd records.
exec docker run --rm --name "$NAME" \
  --hostname "$NAME" \
  --init \
  --user "${uid}:${gid}" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --shm-size=512m \
  --memory=1536m \
  --pids-limit=512 \
  --network "$NETWORK" \
  -e "TZ=${tz:-Asia/Kolkata}" \
  -e "CREDENTIALS_DIRECTORY=/run/creds" \
  -e "NAUKRI_DRY_RUN=${NAUKRI_DRY_RUN:-0}" \
  -e "LOG_LEVEL=${LOG_LEVEL:-info}" \
  -v /etc/localtime:/etc/localtime:ro \
  -v /etc/naukri-refresher:/etc/naukri-refresher:ro \
  -v /var/lib/naukri-refresher:/var/lib/naukri-refresher:rw \
  -v "${creds}:/run/creds:ro" \
  "$IMAGE" --task "$TASK"
