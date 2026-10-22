# CCTV Web Monitor

A self-hosted web app to watch your CCTV cameras in a browser, built from the
features reverse-engineered out of the **X-IOT CAM [5.5]** Android app — but
using **open standards** (RTSP / ONVIF / WebRTC) instead of the app's closed
P2P SDK, so it runs entirely on your own infrastructure.

```
 IP camera ──RTSP/ONVIF──▶ go2rtc ──WebRTC/MSE/HLS──▶ browser dashboard
                              ▲                            │
                              └────── Node API (PTZ, snapshot, config) ◀┘
```

## Why not just copy the X-IOT app?

The X-IOT app (`shix.go.zoom`) reaches cameras through the proprietary
`object.p2pipcam` **P2P SDK**: a closed native `.so` plus the vendor's relay
("supernode") cloud, addressed by the camera's **UID/DID**. That protocol
can't run in a browser and isn't ours to reimplement. The good news: the same
cameras almost always *also* speak **RTSP + ONVIF** on the LAN, which browsers
(via a tiny gateway) handle natively. This project rebuilds the useful parts on
that open foundation.

### Feature mapping (X-IOT app → this project)

| X-IOT app (P2P SDK) | Here (open standard) |
|---|---|
| `StartPPPP(uid,user,pwd)` connect by UID | RTSP URL `rtsp://user:pass@ip:554/...` |
| `StartPPPPLivestream` + `callBaceVideoData` → decode H.264 | go2rtc pulls RTSP, serves **WebRTC** (low latency) to the browser |
| `PPPPPTZControl` | **ONVIF** `continuousMove` (`/api/ptz/:id`) |
| `getSnapshot` | go2rtc `frame.jpeg` (`/api/snapshot/:id`) |
| SD card = on-device storage | **server-side recording** you own: continuous clips on disk, browse + play in the UI |
| `PPPPGetSDCardRecordFileList` / `StartPlayBack` | `/api/recordings/:id` list + `/rec/...` playback with seeking |
| `DeletFile` (delete one) | delete a clip (`DELETE /api/recordings/:id/:file`) |
| `TransferMessage {"pro":"set_sd","cmd":110,"format":1}` (wipe SD) | **Wipe all** server footage (`POST /api/recordings/:id/wipe`), **or** call the camera's own format CGI (`/api/sdcard/:id/format`) when configured |
| vendor P2P relay for remote access | your own WireGuard/Tailscale/frp, or WebRTC + TURN |

## Requirements

- Docker + Docker Compose (easiest), **or** Node.js ≥ 18 and a local
  [`go2rtc`](https://github.com/AlexxIT/go2rtc) binary.
- Cameras that expose RTSP (and ONVIF if you want PTZ). Find the RTSP URL in the
  camera's web UI or its datasheet. Many HiChip/VStarcam-type cameras (the same
  family as X-IOT) expose RTSP once enabled in firmware.

## Quick start (Docker)

```bash
cp cameras.example.json cameras.json   # edit with your real RTSP URLs
docker compose up -d
# open http://localhost:3000
```

## Quick start (no Docker)

```bash
# 1) run go2rtc (download the single binary for your OS from its releases page)
./go2rtc -config go2rtc.yaml &
# 2) run the web app
cp cameras.example.json cameras.json
cp .env.example .env
npm install
npm start
# open http://localhost:3000
```

## Using it

- **Add camera**: click **+ Add camera**, paste the RTSP URL (and ONVIF details
  for PTZ). It's saved to `cameras.json` and registered with go2rtc live.
- **Grid**: 1–4 columns; each tile shows live video, a status dot (green =
  go2rtc has the stream connected), a **● REC** badge when recording, snapshot
  ⤓, recordings ⏺, fullscreen ⛶, and PTZ arrows when ONVIF is configured.
- Credentials in `cameras.json` (RTSP, ONVIF, SD CGI) stay server-side; the
  browser only ever gets `id`, `name`, and capability flags.

## Recordings & deleting footage (the “memory” feature)

This is the open-standard answer to the app's SD card. It works two ways:

### 1. Server-side recording (default, reliable, camera-agnostic)

Set `"record": true` on a camera. The server runs `ffmpeg` to segment its RTSP
into MP4 clips under `recordings/<id>/` — **storage you own**, not the camera's
SD. In the UI, click **⏺** on a tile to:

- see the clip list (newest first) with time + size,
- **play** a clip in-browser (seekable) or **download** it,
- **delete** one clip (= the app's `DeletFile`),
- **Wipe all** server footage for that camera (= the app's SD format, but on
  your disk and reversible only from your backups).

Retention is automatic: `REC_MAX_DAYS` (age) and optional `REC_MAX_GB` (size)
trim old clips. Recording needs `ffmpeg` (bundled in the Docker image; install
it yourself for the no-Docker path — the app still runs without it, just with
recording disabled).

### 2. Format the camera's own SD card (optional, model-specific)

If your camera exposes an HTTP/CGI endpoint to format its card, add an `sd`
block to the camera (Info URL / Format URL — see `cameras.example.json`). The
**Format camera SD** button then calls it through `/api/sdcard/:id/format`.
This is the literal equivalent of the app's `{"pro":"set_sd","cmd":110}`, but
over the camera's own LAN API instead of the vendor P2P tunnel. It is guarded by
a typed/clicked confirmation because it is irreversible, and it is inert unless
you configure the URL for your exact model.

## Scheduled archive + safe auto-format

A built-in scheduler (`server/scheduler.js`) runs two jobs so a small camera SD
never fills up, **without ever losing footage**:

- **Archive — every hour** (`ARCHIVE_EVERY_MIN`, default 60): copies the
  camera's SD recordings to the server under `recordings/<id>/sd/`. Files
  already archived with a matching size are skipped, so it only pulls what's
  new. Needs the camera's `sd.listUrl` + `sd.downloadUrl`. For cameras with no
  such API, the continuous live recorder (`record: true`) is the archive
  instead.
- **Safe auto-format — every 24 h** (per-camera `autoFormat.everyHours`): wipes
  the camera SD **only after proving the footage is on the server**.

### The safety gate (why it won't lose video)

Before any format — scheduled or manual — the server:

1. runs a fresh archive pass, then
2. **verifies 100% coverage**:
   - CGI cameras: re-lists the SD and checks every file now exists on the server
     with a matching size. Any missing/short file → **format ABORTED**.
   - Live-recorder cameras: requires the recorder to be running now **and** to
     have produced enough clips to cover the window (gaps → **ABORTED**).
3. formats **only if** verification passed, and writes an audit entry
   (`/api/scheduler` shows the last result and the abort reason if it skipped).

So the order is always **save → verify → then format**, never the reverse. If
anything is unproven, the card is left untouched and the reason is logged.

Enable it per camera with `"autoFormat": { "enabled": true, "everyHours": 24 }`
(see `cameras.example.json`). `AUTO_FORMAT=0` disables all auto-format globally.
In the ⏺ modal you also get **Archive now** and **Safe-format SD now** buttons
and a line showing the last archive/format time.

API: `GET /api/scheduler` (status + last results), `POST /api/archive/:id`
(archive now), `POST /api/format/:id` with `{"confirm":"<id>"}` (safe-format
now — same gate).

## Getting a P2P-only X-IOT camera into the monitor

The X-IOT app is **pure P2P**: it reaches a camera by its UID (e.g.
`XIOTB-021580-TJBSS`) through the vendor cloud (`cyczcam`), and its APK contains
**no RTSP or ONVIF** at all. This monitor needs RTSP/ONVIF on your LAN, so the
UID can't be used directly. Many cameras in this family still expose RTSP on
port 554 even though the app ignores it — check yours.

**From the web UI (easiest):** click **🔍 Discover** in the top bar → optionally
type the camera's user/pass → **ONVIF auto-scan** (or type your subnet like
`192.168.1` and **Scan subnet :554**). Found cameras are listed; click **Find
RTSP** if credentials are needed, then **Add** to save it to the dashboard in
one click. (Discovery runs on the server's LAN, so run the app on a machine on
the same network as the cameras; the Docker setup already uses host networking.)

**From the CLI** (same detection engine):

```bash
# 1) find the camera's IP (also check your router's DHCP client list)
node tools/probe.mjs discover                 # ONVIF auto-discovery
node tools/probe.mjs scan 192.168.1           # scan your subnet for RTSP :554

# 2) once you know the IP, find a working RTSP URL + credentials
node tools/probe.mjs rtsp 192.168.1.50        # tries common paths + default logins
node tools/probe.mjs rtsp 192.168.1.50 admin yourpassword
```

- **If it finds a working `rtsp://…` URL** → add the camera with it (keep the UID
  as the id so you recognise it):
  ```json
  { "id": "XIOTB-021580-TJBSS", "name": "CCTV 1",
    "rtsp": "rtsp://admin:yourpass@192.168.1.50:554/<path probe found>",
    "record": true, "autoFormat": { "enabled": true, "everyHours": 24 } }
  ```
- **If port 554 is closed / nothing matches** → that camera has no open stream;
  the only ways to view it are the vendor P2P SDK (closed native lib — not
  portable to the web), enabling RTSP/ONVIF in the camera's own settings if it
  offers it, or using an ONVIF-capable camera. The monitor can't bridge raw P2P.

## Remote ("online") access

On the LAN this works as-is. To reach it from the internet like the app's P2P:

- **Easiest & safest**: put the host on **Tailscale/WireGuard** and open the
  dashboard over the VPN. No ports exposed.
- **Public**: terminate TLS with a reverse proxy (Caddy/nginx), add
  authentication, and set go2rtc WebRTC `candidates` + a TURN server in
  `go2rtc.yaml` so WebRTC traverses NAT.

Never expose raw RTSP or the dashboard to the internet without auth + TLS.

## Layout

```
server/index.js   Express API + static UI + go2rtc proxy
server/go2rtc.js  registers RTSP streams with go2rtc, snapshots, status
server/onvif.js   ONVIF PTZ / snapshot (optional dependency)
server/recorder.js ffmpeg segment recorder + retention + clip management
server/scheduler.js hourly SD->server archive + daily safe-format (verify first)
public/           dashboard (grid, player, PTZ, recordings, add-camera)
tools/probe.mjs   LAN probe: find camera IP + working RTSP URL (ONVIF discovery)
go2rtc.yaml       media engine listeners
cameras.json      your cameras (gitignored; copy from cameras.example.json)
recordings/       recorded clips per camera (gitignored)
```
