#!/usr/bin/env bash
# Task 2 test: the harness must stream a valid, decodable video to STDOUT.
# This camera (XIOTB VGA) delivers MJPEG — a run of self-contained JPEG frames
# (ruling 2026-10-23: no H.264 on this device; mode 1 = 640x480 MJPEG).
#
# PASS: ffprobe recognizes an mjpeg video stream with real (>0) dimensions in
# the bytes the harness wrote to stdout. ffprobe comes from the go2rtc image
# (host has no ffmpeg); credentials from p2p/secrets.env.
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-xiot-bionic:arm64}
FFIMAGE=${FFIMAGE:-docker.io/alexxit/go2rtc:latest}
WIN=${WIN:-45}
[ -f secrets.env ] && set -a && . ./secrets.env && set +a
UID_CAM=${XIOT_CAM_UID:?set XIOT_CAM_UID in p2p/secrets.env}
USER_CAM=${XIOT_CAM_USER:-admin}
PWD_CAM=${XIOT_CAM_PWD:?set XIOT_CAM_PWD in p2p/secrets.env}

CAPDIR=$(mktemp -d)
trap 'rm -rf "$CAPDIR"' EXIT
CAP="$CAPDIR/cap.mjpeg"

timeout "$WIN" docker run --rm --network host -v "$PWD/out":/work/out -v "$PWD/libs":/work -w /work \
  -e XIOT_STREAM="${XIOT_STREAM:-1}" \
  --entrypoint /work/out/harness "$IMAGE" "$UID_CAM" "$USER_CAM" "$PWD_CAM" \
  >"$CAP" 2>/dev/null || true

sz=$(stat -c%s "$CAP" 2>/dev/null || echo 0)
echo "captured ${sz} bytes to stdout"

res=$(docker run --rm -v "$CAPDIR":/d:ro --entrypoint ffprobe "$FFIMAGE" \
  -v error -f mjpeg -select_streams v:0 \
  -show_entries stream=codec_name,width,height -of csv /d/cap.mjpeg 2>/dev/null)
echo "ffprobe: ${res:-<none>}"

if echo "$res" | grep -qE '^stream,mjpeg,[1-9][0-9]*,[1-9][0-9]*'; then
  echo "PASS: valid MJPEG video on stdout"; exit 0
fi
echo "FAIL: stdout did not carry a decodable MJPEG video stream"; exit 1
