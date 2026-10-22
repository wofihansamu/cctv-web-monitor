#!/usr/bin/env bash
# Task 3 test: the bridge container publishes the camera into go2rtc.
# The bridge runs the arm64 harness (qemu) piped to a static x86_64 ffmpeg that
# transcodes the camera's MJPEG to H.264 and pushes it via RTSP into go2rtc's
# empty stream <STREAM> (declared in go2rtc.yaml). We then ask go2rtc for a
# single JPEG frame of that stream.
#
# PASS: GET /api/frame.jpeg?src=<STREAM> returns a JPEG larger than 1KB.
set -uo pipefail
cd "$(dirname "$0")/.."

BRIDGE_IMAGE=${BRIDGE_IMAGE:-xiot-bridge:latest}
GO2RTC_API=${GO2RTC_API:-http://localhost:1984}
STREAM=${STREAM:-xiotcam}
WIN=${WIN:-70}
[ -f secrets.env ] && set -a && . ./secrets.env && set +a
: "${XIOT_CAM_UID:?set XIOT_CAM_UID in p2p/secrets.env}"
: "${XIOT_CAM_PWD:?set XIOT_CAM_PWD in p2p/secrets.env}"

# go2rtc must be up with the empty stream declared.
command -v docker >/dev/null || { echo "FAIL: docker missing"; exit 1; }
( cd .. && docker compose up -d go2rtc >/dev/null 2>&1 ) || true
for i in $(seq 1 20); do curl -sf -m2 "$GO2RTC_API/api/streams" >/dev/null 2>&1 && break; sleep 1; done

CNAME="xiot-bridge-test-$$"
cleanup(){ docker rm -f "$CNAME" >/dev/null 2>&1; }
trap cleanup EXIT

docker rm -f "$CNAME" >/dev/null 2>&1
docker run -d --rm --name "$CNAME" --network host \
  -e XIOT_CAM_UID="$XIOT_CAM_UID" -e XIOT_CAM_USER="${XIOT_CAM_USER:-admin}" \
  -e XIOT_CAM_PWD="$XIOT_CAM_PWD" -e XIOT_STREAM="${XIOT_STREAM:-1}" \
  -e STREAM_NAME="$STREAM" \
  "$BRIDGE_IMAGE" >/dev/null 2>&1 || { echo "FAIL: cannot start bridge image $BRIDGE_IMAGE"; exit 1; }

echo "bridge started; waiting up to ${WIN}s for a frame on go2rtc stream '$STREAM'..."
deadline=$(( $(date +%s) + WIN ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  code=$(curl -s -o /tmp/bridge_f.jpg -w '%{http_code}' -m 8 "$GO2RTC_API/api/frame.jpeg?src=$STREAM" 2>/dev/null)
  sz=$(stat -c%s /tmp/bridge_f.jpg 2>/dev/null || echo 0)
  if [ "$code" = 200 ] && [ "$sz" -gt 1024 ]; then
    echo "PASS: go2rtc served a ${sz}-byte JPEG for '$STREAM'"
    file /tmp/bridge_f.jpg
    exit 0
  fi
  sleep 3
done
echo "FAIL: no JPEG frame from go2rtc stream '$STREAM' within ${WIN}s (last http=$code size=$sz)"
echo "--- bridge logs (tail) ---"; docker logs "$CNAME" 2>&1 | tail -15
exit 1
