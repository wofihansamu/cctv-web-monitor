# X-IOT P2P camera bridge (on the server)

Runs the vendor X-IOT P2P library (`libobject_jni.so`, arm64) on an x86 server
via emulation, connects to the camera by **UID + camera password** over the
vendor relay (NAT traversal — no account login needed), and feeds the video to
go2rtc. See the design and plan in
`../docs/superpowers/specs/2026-10-22-xiot-p2p-server-bridge-design.md` and
`../docs/superpowers/plans/2026-10-22-xiot-p2p-server-bridge.md`.

This camera streams **MJPEG 640×480** (mode 1) or 320×240 (mode 2). It has **no
H.264 stream** — the app's "4K/2K/1080/720" labels are generic UI, the sensor is
VGA. The bridge transcodes the MJPEG to H.264 (x86 ffmpeg) for the browser.

## How it works

```
harness (arm64, under qemu) ──MJPEG stdout──▶ ffmpeg (x86, native) ──H.264 RTSP──▶ go2rtc ──▶ browser
        libobject_jni.so                         transcode                push into empty stream
```

One bridge container holds both binaries: the arm64 harness runs through the
host's binfmt-qemu while the static x86_64 ffmpeg runs natively (they share the
host kernel). go2rtc only accepts a push to a stream that already exists with an
empty source, so each P2P camera needs a one-line empty entry in `go2rtc.yaml`
(the REST API cannot create empty streams).

## Prerequisites

- Docker, and arm64 binfmt (registered automatically by `build-runtime.sh` via
  `multiarch/qemu-user-static --reset -p yes`).
- Android NDK r26d. Set `ANDROID_NDK` to the NDK root before `build-harness.sh`.
- Vendor libraries in `p2p/libs/` (from the arm64_v8a APK split):
  `libobject_jni.so`, `libav*.so`, `libsw*.so`, `libpostproc.so`,
  `libc++_shared.so`. These are vendor artifacts; not committed (see `.gitignore`).

## Build

```bash
./p2p/build-runtime.sh                              # build image xiot-bionic:arm64 (once, large)
ANDROID_NDK=/path/to/ndk ./p2p/build-harness.sh     # compile p2p/out/harness
docker build -f p2p/Dockerfile.bridge -t xiot-bridge:latest p2p   # bridge image
```

## Credentials

Copy `secrets.example.env` → `secrets.env` (gitignored) and fill in:

- `XIOT_CAM_UID` — camera UID (e.g. `XIOTB-021580-TJBSS`)
- `XIOT_CAM_USER` — default `admin`
- `XIOT_CAM_PWD` — camera password
- `XIOT_STREAM` — 1 (640×480, default) or 2 (320×240)

A vendor **account** login is **not** required: UID + camera password reach
`ON_LINE(2)` on their own.

## Gates (go/no-go)

```bash
./p2p/test/gate-online.sh       # PASS when the camera reaches ON_LINE(2)
./p2p/test/capture-valid.sh     # PASS when the harness emits a valid MJPEG stream on stdout
./p2p/test/bridge-go2rtc.sh     # PASS when go2rtc serves a JPEG for the pushed stream
./p2p/test/secrets-guard.sh     # PASS when the bridge fails closed without credentials
```

If the camera is genuinely offline, `gate-online.sh` reports
`DEVICE_NOT_ON_LINE(6)` — check the camera is live (e.g. in the phone app) and
retry. Don't build on top of a gate that hasn't passed.

## Run

Declare the stream in `go2rtc.yaml` (`streams:` → `  <id>:`), add the camera to
`cameras.json` with a `p2p` block (see `../cameras.example.json`), then:

```bash
docker compose --profile p2p up -d --build
```

The bridge has `restart: always`; the harness retries the connect while offline
and exits on a mid-stream stall, so the container reconnects on its own.

## Limitations

Depends on the vendor cloud/relay staying up — not an offline solution. Runs the
arm64 lib under qemu (CPU-heavy for a continuous stream). MJPEG VGA only
(~1.5–2 fps at 640×480).
