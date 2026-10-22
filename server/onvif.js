// ONVIF helpers: PTZ, snapshot URL, and recording search.
// These map the X-IOT app's proprietary JSON-over-P2P commands to the open
// ONVIF standard most IP cameras expose on the LAN:
//   PPPPPTZControl        -> ONVIF PTZ continuousMove / stop
//   getSnapshot           -> ONVIF media GetSnapshotUri
//   PPPPGetSDCardRecordFileList -> ONVIF Replay/Recording search (where supported)
//
// `onvif` is an optional dependency: a camera entry without an `onvif` block
// simply won't expose these controls, and the import is guarded so the app
// still runs for RTSP-only cameras.

let Cam = null;
try {
  ({ Cam } = await import("onvif/promises"));
} catch {
  try {
    const mod = await import("onvif");
    Cam = mod.Cam; // older callback API; wrapped below
  } catch {
    Cam = null;
  }
}

const cache = new Map();

function connect(o) {
  if (!Cam) throw new Error("onvif package not installed");
  const key = `${o.host}:${o.port || 80}`;
  if (cache.has(key)) return cache.get(key);
  const p = new Promise((resolve, reject) => {
    const cam = new Cam(
      { hostname: o.host, port: o.port || 80, username: o.user, password: o.pass, timeout: 8000 },
      (err) => (err ? reject(err) : resolve(cam))
    );
  });
  cache.set(key, p);
  return p;
}

export function onvifAvailable() {
  return !!Cam;
}

export async function ptzMove(o, { x = 0, y = 0, zoom = 0 }) {
  const cam = await connect(o);
  await new Promise((resolve, reject) =>
    cam.continuousMove({ x, y, zoom }, (e) => (e ? reject(e) : resolve()))
  );
  // Auto-stop after a short nudge so the UI buttons behave like press-to-move.
  setTimeout(() => cam.stop({ panTilt: true, zoom: true }, () => {}), 600);
}

export async function ptzStop(o) {
  const cam = await connect(o);
  await new Promise((resolve) => cam.stop({ panTilt: true, zoom: true }, () => resolve()));
}

export async function snapshotUri(o) {
  const cam = await connect(o);
  return new Promise((resolve, reject) =>
    cam.getSnapshotUri({}, (e, r) => (e ? reject(e) : resolve(r?.uri)))
  );
}
