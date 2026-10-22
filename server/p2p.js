// P2P (X-IOT) camera integration.
//
// Unlike RTSP/ONVIF cameras, a P2P camera has no pullable URL. Its video comes
// from the vendor P2P stack running in the `p2p-bridge` container, which pushes
// H.264 into go2rtc over RTSP as an empty stream named after the camera id (see
// p2p/ and go2rtc.yaml). So the Node server does NOT registerStream() a p2p
// camera; it only verifies go2rtc has the (config-declared) empty stream and
// surfaces status. Reconnect is handled by the bridge: the harness retries the
// P2P connect while offline and exits on a mid-stream stall, and the container's
// `restart: always` brings it back.

import { streamInfo } from "./go2rtc.js";
import { producerOnline } from "./status.js";

export function isP2P(cam) {
  return !!(cam && cam.p2p && cam.p2p.uid);
}

// go2rtc stream name for a p2p camera (same as its id; matches the bridge's
// STREAM_NAME and the empty stream declared in go2rtc.yaml).
export function p2pStreamName(cam) {
  return cam.id;
}

// Verify go2rtc knows this p2p camera's stream (it must be declared empty in
// go2rtc.yaml for the bridge's push to be accepted). Returns true if present.
// Logs a clear warning when missing — the REST API cannot create empty streams,
// so a missing entry means the push will be refused until go2rtc.yaml is fixed.
export async function ensureP2PStream(cam) {
  const name = p2pStreamName(cam);
  try {
    await streamInfo(name); // 200 for a declared stream (even with no producer)
    return true;
  } catch {
    console.warn(
      `[p2p] go2rtc has no stream "${name}". Add an empty entry under "streams:" ` +
        `in go2rtc.yaml (the REST API cannot create empty streams) and restart go2rtc.`
    );
    return false;
  }
}

// Current status for a p2p camera's dot, derived from go2rtc producers.
export async function p2pStatus(cam) {
  const name = p2pStreamName(cam);
  try {
    const info = await streamInfo(name);
    return { online: producerOnline(info), state: producerOnline(info) ? "online" : "offline" };
  } catch (e) {
    return { online: false, state: "offline", error: e.message };
  }
}
