#!/usr/bin/env bash
# GO/NO-GO gate (plan Task 1): does the P2P session reach PPPP status
# ON_LINE(2) for the target camera? Reads credentials from p2p/secrets.env.
#
# PASS: a status line with param==2 (ON_LINE) is observed within the window.
# Otherwise FAIL, printing the highest status reached (diagnostic).
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-xiot-bionic:arm64}
WIN=${WIN:-90}
[ -f secrets.env ] && set -a && . ./secrets.env && set +a
UID_CAM=${XIOT_CAM_UID:?set XIOT_CAM_UID in p2p/secrets.env}
USER_CAM=${XIOT_CAM_USER:-admin}
PWD_CAM=${XIOT_CAM_PWD:?set XIOT_CAM_PWD in p2p/secrets.env}

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
timeout "$WIN" docker run --rm --network host -v "$PWD/out":/work/out -v "$PWD/libs":/work -w /work \
  -e XIOT_ACC_USER="${XIOT_ACC_USER:-}" -e XIOT_ACC_PWD="${XIOT_ACC_PWD:-}" \
  --entrypoint /work/out/harness "$IMAGE" "$UID_CAM" "$USER_CAM" "$PWD_CAM" \
  > "$LOG" 2>&1 || true

if grep -qE "STATUS .*${UID_CAM} .* 2$" "$LOG"; then
  echo "PASS: reached ON_LINE(2)"; exit 0
fi
hi=$(grep -oE 'STATUS .* [0-9]+$' "$LOG" | awk '{print $NF}' | sort -n | tail -1)
echo "FAIL: highest PPPP status reached = ${hi:-none}"
exit 1
