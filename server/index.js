import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as g2 from "./go2rtc.js";
import * as onvif from "./onvif.js";
import * as rec from "./recorder.js";
import * as sched from "./scheduler.js";
import * as discovery from "./discovery.js";
import * as p2p from "./p2p.js";
import { producerOnline } from "./status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const GO2RTC_URL = process.env.GO2RTC_URL || "http://localhost:1984";
const GO2RTC_PUBLIC_URL = process.env.GO2RTC_PUBLIC_URL || GO2RTC_URL;
const CAMERAS_FILE = join(ROOT, "cameras.json");

const app = express();
app.use(express.json());

// ---- camera store -----------------------------------------------------------
async function loadCameras() {
  const path = existsSync(CAMERAS_FILE) ? CAMERAS_FILE : join(ROOT, "cameras.example.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}
async function saveCameras(list) {
  await writeFile(CAMERAS_FILE, JSON.stringify(list, null, 2));
}
const byId = (list, id) => list.find((c) => c.id === id);

async function syncStreams() {
  const cams = await loadCameras();
  for (const c of cams) {
    // P2P cameras are pushed into go2rtc by the bridge container; the empty
    // stream is declared in go2rtc.yaml, so we only verify it exists here.
    if (p2p.isP2P(c)) {
      await p2p.ensureP2PStream(c);
      continue;
    }
    if (c.rtsp) await g2.registerStream(c.id, c.rtsp).catch((e) => console.warn("register", c.id, e.message));
  }
  console.log(`Registered ${cams.length} camera stream(s) with go2rtc`);
}

// Call a camera's own HTTP endpoint (CGI), moving any user:pass@ into a header.
async function camFetch(rawUrl, method = "GET") {
  const u = new URL(rawUrl);
  const headers = {};
  if (u.username || u.password) {
    headers.Authorization = "Basic " + Buffer.from(`${u.username}:${u.password}`).toString("base64");
    u.username = u.password = "";
  }
  const res = await fetch(u.toString(), { method, headers, signal: AbortSignal.timeout(8000) });
  const body = await res.text();
  return { status: res.status, body };
}

// ---- API --------------------------------------------------------------------
app.get("/api/config", async (_req, res) => {
  res.json({
    go2rtc: GO2RTC_PUBLIC_URL,
    onvif: onvif.onvifAvailable(),
    recording: await rec.recordingEnabled(),
  });
});

app.get("/api/cameras", async (_req, res) => {
  const cams = await loadCameras();
  res.json(
    cams.map((c) => ({
      id: c.id,
      name: c.name,
      record: !!c.record,
      p2p: !!c.p2p,
      hasOnvif: !!c.onvif,
      hasSd: !!(c.sd && (c.sd.infoUrl || c.sd.formatUrl)),
      canArchive: !!((c.sd?.listUrl && c.sd?.downloadUrl) || c.record),
      autoFormat: !!c.autoFormat?.enabled,
    }))
  );
});

app.post("/api/cameras", async (req, res) => {
  const { id, name, rtsp, p2p: p2pCfg, onvif: ov, sd, record, autoFormat } = req.body || {};
  const hasP2P = !!(p2pCfg && p2pCfg.uid);
  if (!id || (!rtsp && !hasP2P)) return res.status(400).json({ error: "id and rtsp (or p2p.uid) are required" });
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: "id must be alphanumeric/_/-" });
  const cams = await loadCameras();
  const entry = {
    id,
    name: name || id,
    record: !!record,
    ...(rtsp ? { rtsp } : {}),
    ...(hasP2P ? { p2p: p2pCfg } : {}),
    ...(ov ? { onvif: ov } : {}),
    ...(sd ? { sd } : {}),
    ...(autoFormat ? { autoFormat } : {}),
  };
  const i = cams.findIndex((c) => c.id === id);
  if (i >= 0) cams[i] = entry;
  else cams.push(entry);
  await saveCameras(cams);
  if (rtsp) await g2.registerStream(id, rtsp).catch(() => {});
  else if (hasP2P) await p2p.ensureP2PStream(entry).catch(() => {});
  await rec.syncRecorder(cams).catch(() => {});
  res.json({ ok: true, ...(hasP2P ? { note: "p2p camera: ensure go2rtc.yaml has an empty stream and the p2p-bridge runs for it" } : {}) });
});

app.delete("/api/cameras/:id", async (req, res) => {
  const cams = await loadCameras();
  const next = cams.filter((c) => c.id !== req.params.id);
  await saveCameras(next);
  await g2.deleteStream(req.params.id);
  await rec.syncRecorder(next).catch(() => {});
  res.json({ ok: true, note: "recordings on disk were kept; use wipe to delete them" });
});

app.get("/api/status/:id", async (req, res) => {
  try {
    const info = await g2.streamInfo(req.params.id);
    res.json({ online: producerOnline(info), recording: rec.isRecording(req.params.id) });
  } catch (e) {
    res.json({ online: false, recording: rec.isRecording(req.params.id), error: e.message });
  }
});

app.get("/api/snapshot/:id", async (req, res) => {
  try {
    res.set("Content-Type", "image/jpeg").send(await g2.frameJpeg(req.params.id));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// PTZ (ONVIF) — analogue of PPPPPTZControl
app.post("/api/ptz/:id", async (req, res) => {
  const cam = byId(await loadCameras(), req.params.id);
  if (!cam?.onvif) return res.status(400).json({ error: "camera has no onvif config" });
  try {
    const { x = 0, y = 0, zoom = 0, stop } = req.body || {};
    if (stop) await onvif.ptzStop(cam.onvif);
    else await onvif.ptzMove(cam.onvif, { x, y, zoom });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- recordings = your own "SD card" on the server -------------------------
app.get("/api/recordings/:id", async (req, res) => {
  try {
    const clips = await rec.listClips(req.params.id);
    const archived = await sched.listArchived(req.params.id);
    res.json({ recording: rec.isRecording(req.params.id), clips, archived });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/recordings/:id/:file", async (req, res) => {
  try {
    await rec.deleteClip(req.params.id, req.params.file);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Wipe all footage for a camera — the open equivalent of {"pro":"set_sd","format":1}
app.post("/api/recordings/:id/wipe", async (req, res) => {
  try {
    await rec.wipeCamera(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// static playback with HTTP Range (seeking) for <video>
app.use("/rec", express.static(rec.RECORDINGS_DIR, { acceptRanges: true, index: false }));

// ---- optional: talk to the camera's OWN SD card via its HTTP CGI -----------
// Only active when a camera has an `sd: { infoUrl, formatUrl }` block. This is
// the closest open analogue to the app's on-device format; it is vendor-
// specific, so you supply the exact URL for your model.
app.get("/api/sdcard/:id", async (req, res) => {
  const cam = byId(await loadCameras(), req.params.id);
  if (!cam?.sd?.infoUrl) return res.status(400).json({ error: "no sd.infoUrl configured" });
  try {
    res.json(await camFetch(cam.sd.infoUrl, cam.sd.method || "GET"));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/sdcard/:id/format", async (req, res) => {
  const cam = byId(await loadCameras(), req.params.id);
  if (!cam?.sd?.formatUrl) return res.status(400).json({ error: "no sd.formatUrl configured" });
  if (req.body?.confirm !== cam.id) return res.status(400).json({ error: `send {"confirm":"${cam.id}"} to format` });
  try {
    res.json(await camFetch(cam.sd.formatUrl, cam.sd.formatMethod || "GET"));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- discovery: find cameras on the LAN from the UI ------------------------
app.get("/api/discover", async (_req, res) => {
  try {
    const devices = await discovery.discover();
    // enrich each ONVIF device with a quick RTSP probe (no creds / defaults)
    const out = [];
    for (const d of devices) out.push({ ...d, ...(await discovery.probeRtsp(d.ip)) });
    res.json({ devices: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/discover/rtsp", async (req, res) => {
  const { ip, user, pass } = req.body || {};
  if (!ip) return res.status(400).json({ error: "ip required" });
  try {
    res.json(await discovery.probeRtsp(ip, user, pass));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/discover/scan", async (req, res) => {
  const { subnet, user, pass } = req.body || {};
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet || "")) return res.status(400).json({ error: "subnet like 192.168.1 required" });
  try {
    res.json({ results: await discovery.scanSubnet(subnet, user, pass) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- scheduled archive + safe auto-format ----------------------------------
app.get("/api/scheduler", (_req, res) => res.json(sched.schedulerStatus()));

// manually run the hourly archive for one camera now
app.post("/api/archive/:id", async (req, res) => {
  const cam = byId(await loadCameras(), req.params.id);
  if (!cam) return res.status(404).json({ error: "no such camera" });
  try {
    res.json(await sched.archiveCamera(cam));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// manually run the SAFE format (archive + verify, then format only if proven safe)
app.post("/api/format/:id", async (req, res) => {
  const cam = byId(await loadCameras(), req.params.id);
  if (!cam) return res.status(404).json({ error: "no such camera" });
  if (req.body?.confirm !== cam.id) return res.status(400).json({ error: `send {"confirm":"${cam.id}"}` });
  try {
    res.json(await sched.formatCamera(cam, { manual: true }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- proxy go2rtc same-origin ----------------------------------------------
app.use(
  "/go2rtc",
  createProxyMiddleware({ target: GO2RTC_URL, changeOrigin: true, ws: true, pathRewrite: { "^/go2rtc": "" } })
);

app.use(express.static(join(ROOT, "public")));

// ---- boot -------------------------------------------------------------------
(async () => {
  try {
    await g2.waitForGo2rtc();
    await syncStreams();
  } catch (e) {
    console.warn("go2rtc not ready:", e.message, "— UI will still start.");
  }
  await rec.startRecorder(loadCameras).catch((e) => console.warn("recorder:", e.message));
  await sched.startScheduler(loadCameras).catch((e) => console.warn("scheduler:", e.message));
  app.listen(PORT, () => console.log(`CCTV web monitor on http://localhost:${PORT}`));
})();
