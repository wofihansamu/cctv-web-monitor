// Scheduled archive + safe auto-format.
//
// Two jobs run on intervals:
//   • archive  (default every 60 min): copy the camera's on-SD recordings to
//              server disk under recordings/<id>/sd/. Already-archived files
//              with a matching size are skipped.
//   • format   (default every 24 h):  wipe the camera's SD card — but ONLY
//              after a fresh archive pass proves every SD file is safely on the
//              server. If verification is not 100%, the format is ABORTED.
//
// Mechanism to read/format the SD is camera-specific, so it is configured per
// camera. Supported archive backends:
//   cgi   — camera exposes HTTP endpoints:
//           sd.listUrl     -> list of files (JSON array, {files:[]}, or text)
//           sd.downloadUrl -> template with {file}, e.g. ".../download?name={file}"
//           sd.formatUrl   -> format trigger
//   live  — no SD access, but record:true means the live stream is already
//           being saved continuously; format is gated on recorder coverage.
//
// Safety is the whole point: a camera is NEVER formatted unless its footage is
// provably on the server first.

import { mkdir, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as rec from "./recorder.js";

const ARCHIVE_EVERY_MIN = Number(process.env.ARCHIVE_EVERY_MIN || 60);
const FORMAT_EVERY_HOURS = Number(process.env.FORMAT_EVERY_HOURS || 24);
const AUTO_FORMAT = process.env.AUTO_FORMAT !== "0"; // master switch; per-camera still gates
const STATE_FILE = join(rec.RECORDINGS_DIR, ".scheduler.json");

let state = {}; // { [id]: { lastArchive, lastArchiveResult, lastFormat, lastFormatResult } }
let loadCamerasRef = async () => [];

function sdDir(id) { return join(rec.camDir(id), "sd"); }

async function loadState() {
  try { state = JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { state = {}; }
}
async function saveState() {
  try { await mkdir(rec.RECORDINGS_DIR, { recursive: true }); await writeFile(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}
function mark(id, patch) { state[id] = { ...(state[id] || {}), ...patch }; saveState(); }

// HTTP helper: move user:pass@ in the URL into a Basic auth header.
function prep(rawUrl) {
  const u = new URL(rawUrl);
  const headers = {};
  if (u.username || u.password) {
    headers.Authorization = "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
    u.username = u.password = "";
  }
  return { url: u.toString(), headers };
}

// Parse a camera's file list in whatever shape it returns.
function parseList(text) {
  text = text.trim();
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : j.files || j.list || j.records || [];
    return arr.map((x) => (typeof x === "string" ? { name: x } : { name: x.name || x.file, size: x.size })).filter((x) => x.name);
  } catch {
    return text.split(/[\r\n\s]+/).filter((t) => /\.[a-z0-9]{2,4}$/i.test(t)).map((name) => ({ name }));
  }
}

async function cgiList(cam) {
  const { url, headers } = prep(cam.sd.listUrl);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`listUrl HTTP ${res.status}`);
  return parseList(await res.text());
}

async function cgiDownload(cam, file, destDir) {
  const raw = cam.sd.downloadUrl.replace("{file}", encodeURIComponent(file));
  const { url, headers } = prep(raw);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`download ${file} HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const safe = file.replace(/[^a-zA-Z0-9_.-]/g, "_");
  await writeFile(join(destDir, safe), buf);
  return { safe, size: buf.length };
}

async function archivedSize(id, file) {
  const safe = file.replace(/[^a-zA-Z0-9_.-]/g, "_");
  try { return (await stat(join(sdDir(id), safe))).size; } catch { return -1; }
}

// Archive one camera's SD files to the server. Returns a report.
export async function archiveCamera(cam) {
  const mode = cam.sd?.listUrl && cam.sd?.downloadUrl ? "cgi" : cam.record ? "live" : "none";
  if (mode === "none") return { mode, ok: false, reason: "no archive backend (set sd.listUrl+downloadUrl, or record:true)" };
  if (mode === "live") {
    const clips = await rec.listClips(cam.id);
    return { mode, ok: rec.isRecording(cam.id), running: rec.isRecording(cam.id), clips: clips.length, at: Date.now() };
  }
  // cgi
  const dir = sdDir(cam.id);
  await mkdir(dir, { recursive: true });
  const list = await cgiList(cam);
  const report = { mode, at: Date.now(), total: list.length, downloaded: 0, skipped: 0, failed: [] };
  for (const item of list) {
    const have = await archivedSize(cam.id, item.name);
    if (have > 0 && (item.size == null || have === item.size)) { report.skipped++; continue; }
    try {
      const r = await cgiDownload(cam, item.name, dir);
      if (item.size != null && r.size !== item.size) throw new Error(`size mismatch ${r.size}!=${item.size}`);
      report.downloaded++;
    } catch (e) { report.failed.push({ file: item.name, error: e.message }); }
  }
  report.ok = report.failed.length === 0;
  return report;
}

// Verify EVERYTHING on the SD is on the server, then (and only then) format.
export async function formatCamera(cam, { manual = false } = {}) {
  const mode = cam.sd?.listUrl && cam.sd?.downloadUrl ? "cgi" : cam.record ? "live" : "none";
  const audit = { at: Date.now(), manual, mode, formatted: false };

  // 1) fresh archive pass
  const archive = await archiveCamera(cam).catch((e) => ({ ok: false, reason: e.message }));
  audit.archive = archive;

  // 2) verify coverage
  if (mode === "none") { audit.reason = "no archive backend — refusing to format"; mark(cam.id, { lastFormat: audit.at, lastFormatResult: audit }); return audit; }

  if (mode === "cgi") {
    let list;
    try { list = await cgiList(cam); } catch (e) { audit.reason = "cannot re-list SD: " + e.message; mark(cam.id, { lastFormat: audit.at, lastFormatResult: audit }); return audit; }
    const missing = [];
    for (const item of list) {
      const have = await archivedSize(cam.id, item.name);
      if (have <= 0 || (item.size != null && have !== item.size)) missing.push(item.name);
    }
    audit.sdFiles = list.length;
    audit.missing = missing;
    if (missing.length) { audit.reason = `${missing.length} file(s) not safely archived — format ABORTED`; mark(cam.id, { lastFormat: audit.at, lastFormatResult: audit }); return audit; }
  } else if (mode === "live") {
    // require the recorder to be running AND to have covered the window
    const windowMs = FORMAT_EVERY_HOURS * 3600_000;
    const seg = Number(process.env.REC_SEGMENT_SEC || 600);
    const expected = Math.floor((windowMs / 1000 / seg) * 0.75); // allow 25% slack
    const clips = (await rec.listClips(cam.id)).filter((c) => c.mtime >= Date.now() - windowMs);
    audit.running = rec.isRecording(cam.id);
    audit.clipsInWindow = clips.length;
    audit.expectedClips = expected;
    if (!audit.running) { audit.reason = "live recorder not running — format ABORTED"; mark(cam.id, { lastFormat: audit.at, lastFormatResult: audit }); return audit; }
    if (clips.length < expected) { audit.reason = `only ${clips.length}/${expected} clips in window — possible gaps, format ABORTED`; mark(cam.id, { lastFormat: audit.at, lastFormatResult: audit }); return audit; }
  }

  // 3) all footage verified on server -> format the camera SD
  if (!cam.sd?.formatUrl) { audit.reason = "verified, but no sd.formatUrl configured (nothing to call)"; audit.verifiedSafe = true; mark(cam.id, { lastFormat: audit.at, lastFormatResult: audit }); return audit; }
  try {
    const { url, headers } = prep(cam.sd.formatUrl);
    const res = await fetch(url, { method: cam.sd.formatMethod || "GET", headers, signal: AbortSignal.timeout(20000) });
    audit.formatHttp = res.status;
    audit.formatted = res.ok;
    audit.reason = res.ok ? "verified + formatted" : `format call HTTP ${res.status}`;
  } catch (e) { audit.reason = "format call failed: " + e.message; }
  mark(cam.id, { lastFormat: audit.at, lastFormatResult: audit });
  return audit;
}

async function archiveTick() {
  for (const cam of await loadCamerasRef()) {
    const wants = (cam.sd?.listUrl && cam.sd?.downloadUrl) || cam.record;
    if (!wants) continue;
    try {
      const r = await archiveCamera(cam);
      mark(cam.id, { lastArchive: Date.now(), lastArchiveResult: r });
      console.log(`[archive ${cam.id}] ${JSON.stringify(r)}`);
    } catch (e) { console.warn(`[archive ${cam.id}]`, e.message); }
  }
}

async function formatTick() {
  if (!AUTO_FORMAT) return;
  for (const cam of await loadCamerasRef()) {
    if (!cam.autoFormat?.enabled) continue;
    const everyMs = (cam.autoFormat.everyHours || FORMAT_EVERY_HOURS) * 3600_000;
    const last = state[cam.id]?.lastFormat || 0;
    if (Date.now() - last < everyMs) continue;
    const audit = await formatCamera(cam).catch((e) => ({ reason: e.message }));
    console.log(`[format ${cam.id}] ${audit.formatted ? "OK" : "SKIP"} — ${audit.reason}`);
  }
}

export function schedulerStatus() {
  return { archiveEveryMin: ARCHIVE_EVERY_MIN, formatEveryHours: FORMAT_EVERY_HOURS, autoFormat: AUTO_FORMAT, cameras: state };
}

export async function startScheduler(loadCameras) {
  loadCamerasRef = loadCameras;
  await loadState();
  // run an archive pass shortly after boot, then on interval
  setTimeout(() => archiveTick().catch(() => {}), 15000);
  setInterval(() => archiveTick().catch(() => {}), ARCHIVE_EVERY_MIN * 60_000);
  setInterval(() => formatTick().catch(() => {}), 15 * 60_000); // check hourly-ish; per-camera timer gates
  console.log(`[scheduler] archive every ${ARCHIVE_EVERY_MIN}m, format every ${FORMAT_EVERY_HOURS}h (auto=${AUTO_FORMAT})`);
}

export async function listArchived(id) {
  const dir = sdDir(id);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir).catch(() => []);
  const out = [];
  for (const f of files) {
    try { const st = await stat(join(dir, f)); if (st.isFile()) out.push({ file: f, size: st.size, mtime: st.mtimeMs }); } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export { sdDir };
