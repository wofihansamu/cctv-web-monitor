// Server-side recorder = the open-standard equivalent of the camera's SD card.
// For each camera flagged `record: true`, we segment its RTSP into MP4 files on
// disk you control. "Delete memory" then means deleting your own files
// (reliable, camera-agnostic) instead of sending the app's proprietary
// {"pro":"set_sd","cmd":110,"format":1}. Retention trims old clips automatically.

import { spawn } from "node:child_process";
import { mkdir, readdir, stat, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const REC_DIR = resolve(process.env.REC_DIR || "./recordings");
const SEGMENT_SEC = Number(process.env.REC_SEGMENT_SEC || 600); // 10-min clips
const MAX_DAYS = Number(process.env.REC_MAX_DAYS || 7);
const MAX_GB = Number(process.env.REC_MAX_GB || 0); // 0 = no size cap

const procs = new Map(); // id -> { child, stopping }
let ffmpegOk = null;

export const RECORDINGS_DIR = REC_DIR;

async function hasFfmpeg() {
  if (ffmpegOk !== null) return ffmpegOk;
  ffmpegOk = await new Promise((res) => {
    const c = spawn(FFMPEG, ["-version"]);
    c.on("error", () => res(false));
    c.on("exit", (code) => res(code === 0));
  });
  return ffmpegOk;
}

export function camDir(id) {
  return join(REC_DIR, id);
}

// Guard against path traversal from API params.
export function safeFile(id, file) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  if (!/^[a-zA-Z0-9_.-]+\.mp4$/.test(file)) return null;
  const p = join(camDir(id), file);
  if (!p.startsWith(camDir(id))) return null;
  return p;
}

async function startOne(cam) {
  if (procs.has(cam.id)) return;
  const dir = camDir(cam.id);
  await mkdir(dir, { recursive: true });
  const pattern = join(dir, `${cam.id}-%Y%m%d-%H%M%S.mp4`);
  const args = [
    "-nostdin", "-loglevel", "warning",
    "-rtsp_transport", "tcp",
    "-i", cam.rtsp,
    "-an", "-c", "copy", // copy video; drop audio to avoid container issues. Use -c copy with -map 0 to keep audio.
    "-f", "segment",
    "-segment_time", String(SEGMENT_SEC),
    "-segment_format", "mp4",
    "-segment_atclocktime", "1",
    "-reset_timestamps", "1",
    "-strftime", "1",
    pattern,
  ];
  const child = spawn(FFMPEG, args);
  const state = { child, stopping: false };
  procs.set(cam.id, state);
  child.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.log(`[rec ${cam.id}] ${s.split("\n").pop()}`);
  });
  child.on("exit", (code) => {
    procs.delete(cam.id);
    if (!state.stopping) {
      console.warn(`[rec ${cam.id}] ffmpeg exited (${code}); retry in 5s`);
      setTimeout(() => startOne(cam).catch(() => {}), 5000);
    }
  });
  console.log(`[rec ${cam.id}] recording -> ${dir}`);
}

export function stopOne(id) {
  const s = procs.get(id);
  if (s) {
    s.stopping = true;
    s.child.kill("SIGINT");
    procs.delete(id);
  }
}

export function isRecording(id) {
  return procs.has(id);
}

export async function listClips(id) {
  const dir = camDir(id);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mp4"));
  const out = [];
  for (const f of files) {
    try {
      const st = await stat(join(dir, f));
      if (st.size < 1024) continue; // skip just-opened empty segment
      out.push({ file: f, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export async function deleteClip(id, file) {
  const p = safeFile(id, file);
  if (!p) throw new Error("bad path");
  await rm(p, { force: true });
}

export async function wipeCamera(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("bad id");
  await rm(camDir(id), { recursive: true, force: true });
  await mkdir(camDir(id), { recursive: true });
}

async function enforceRetention() {
  if (!existsSync(REC_DIR)) return;
  const cutoff = Date.now() - MAX_DAYS * 86400_000;
  const cams = await readdir(REC_DIR).catch(() => []);
  let all = [];
  for (const id of cams) {
    for (const c of await listClips(id)) all.push({ id, ...c });
  }
  // age-based trim
  for (const c of all) {
    if (c.mtime < cutoff) await deleteClip(c.id, c.file).catch(() => {});
  }
  // size-based trim (oldest first) if a cap is set
  if (MAX_GB > 0) {
    let fresh = [];
    for (const id of cams) for (const c of await listClips(id)) fresh.push({ id, ...c });
    let total = fresh.reduce((n, c) => n + c.size, 0);
    fresh.sort((a, b) => a.mtime - b.mtime);
    const cap = MAX_GB * 1e9;
    for (const c of fresh) {
      if (total <= cap) break;
      await deleteClip(c.id, c.file).catch(() => {});
      total -= c.size;
    }
  }
}

export async function startRecorder(loadCameras) {
  if (!(await hasFfmpeg())) {
    console.warn("[rec] ffmpeg not found — recording disabled (install ffmpeg to enable).");
    return;
  }
  await mkdir(REC_DIR, { recursive: true });
  const cams = (await loadCameras()).filter((c) => c.record && c.rtsp);
  for (const c of cams) await startOne(c).catch((e) => console.warn("[rec]", c.id, e.message));
  enforceRetention().catch(() => {});
  setInterval(() => enforceRetention().catch(() => {}), 3600_000);
  process.on("SIGINT", () => { for (const id of procs.keys()) stopOne(id); process.exit(0); });
}

// Re-sync when cameras change at runtime.
export async function syncRecorder(cameras) {
  if (!(await hasFfmpeg())) return;
  const want = new Set(cameras.filter((c) => c.record && c.rtsp).map((c) => c.id));
  for (const id of procs.keys()) if (!want.has(id)) stopOne(id);
  for (const c of cameras) if (c.record && c.rtsp && !procs.has(c.id)) await startOne(c).catch(() => {});
}

export const recordingEnabled = hasFfmpeg;
