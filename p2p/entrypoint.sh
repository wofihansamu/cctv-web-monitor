#!/system/bin/sh
# X-IOT P2P bridge entrypoint.
#
# One container, two architectures (they share the host kernel):
#   - /work/out/harness is arm64 and runs under the host's binfmt qemu-user,
#     speaking the vendor P2P stack and emitting the camera's MJPEG to stdout.
#   - ffmpeg is a static x86_64 build and runs natively; it demuxes that MJPEG
#     and transcodes to H.264, then pushes it into go2rtc's RTSP server as the
#     named stream (go2rtc must already have that stream declared empty).
#
# If either stage dies (camera drop → harness stall exit; go2rtc restart →
# broken RTSP push), the pipeline ends and the container exits; compose's
# `restart: always` brings it back, reconnecting the camera.
set -u

: "${XIOT_CAM_UID:?missing XIOT_CAM_UID}"
: "${XIOT_CAM_PWD:?missing XIOT_CAM_PWD}"
USER_CAM="${XIOT_CAM_USER:-admin}"
STREAM_NAME="${STREAM_NAME:-xiotcam}"
GO2RTC_RTSP="${GO2RTC_RTSP:-rtsp://127.0.0.1:8554}"
export LD_LIBRARY_PATH="/work:${LD_LIBRARY_PATH:-}"
export XIOT_STREAM="${XIOT_STREAM:-1}"

echo "[bridge] camera=$XIOT_CAM_UID stream=$STREAM_NAME -> $GO2RTC_RTSP/$STREAM_NAME" >&2

# harness MJPEG (stdout) | ffmpeg transcode to H.264 | RTSP push into go2rtc.
# NB: do NOT use -fflags nobuffer here — it starves ffmpeg's input probe and it
# fails with "Output file does not contain any stream" before the first frames
# arrive. Default probing blocks on the pipe until the camera delivers frames,
# then detects 640x480 MJPEG. -tune zerolatency keeps latency low; keyframe
# every 30 frames for quick WebRTC start.
/work/out/harness "$XIOT_CAM_UID" "$USER_CAM" "$XIOT_CAM_PWD" \
  | ffmpeg -hide_banner -loglevel warning \
      -f mjpeg -i - \
      -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 30 \
      -an -f rtsp -rtsp_transport tcp "$GO2RTC_RTSP/$STREAM_NAME"
status=$?
echo "[bridge] pipeline exited (status=$status); container will restart" >&2
exit "$status"
