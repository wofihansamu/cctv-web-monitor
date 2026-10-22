// CCTV Web Monitor frontend.
// Live tiles embed go2rtc (WebRTC + MSE/HLS fallback) via same-origin proxy.
// Status, snapshot, PTZ, recordings, archive and safe-format go through the API.

const grid = document.getElementById("grid");
const colsSel = document.getElementById("cols");
const addBtn = document.getElementById("addBtn");
const addDlg = document.getElementById("addDlg");
const addForm = document.getElementById("addForm");
const tpl = document.getElementById("tile-tpl");

const recDlg = document.getElementById("recDlg");
const recTitle = document.getElementById("recTitle");
const recSched = document.getElementById("recSched");
const recList = document.getElementById("recList");
const arcList = document.getElementById("arcList");
const recCount = document.getElementById("recCount");
const arcCount = document.getElementById("arcCount");
const recPlayer = document.getElementById("recPlayer");
const recClose = document.getElementById("recClose");
const wipeBtn = document.getElementById("wipeBtn");
const archiveBtn = document.getElementById("archiveBtn");
const formatBtn = document.getElementById("formatBtn");

const discoverBtn = document.getElementById("discoverBtn");
const discDlg = document.getElementById("discDlg");
const discClose = document.getElementById("discClose");
const discList = document.getElementById("discList");
const discStatus = document.getElementById("discStatus");
const onvifScan = document.getElementById("onvifScan");
const subnetScan = document.getElementById("subnetScan");
const subnetInput = document.getElementById("subnet");
const dUser = document.getElementById("dUser");
const dPass = document.getElementById("dPass");

let cfg = {};
let cameras = [];
let current = null;

const api = (p, opts) => fetch(p, opts).then((r) => r.json());
const fmtBytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + " GB" : (n / 1e6).toFixed(0) + " MB");
const fmtTime = (ms) => new Date(ms).toLocaleString();
const ago = (ms) => (ms ? Math.round((Date.now() - ms) / 60000) + "m ago" : "never");

const playerUrl = (id) => `/go2rtc/stream.html?src=${encodeURIComponent(id)}&mode=webrtc,mse,hls`;

function tileFor(cam) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = cam.id;
  node.querySelector(".name").textContent = cam.name || cam.id;
  node.querySelector("iframe").src = playerUrl(cam.id);

  const ptz = node.querySelectorAll(".ptz");
  if (!cam.hasOnvif) ptz.forEach((b) => (b.style.display = "none"));
  ptz.forEach((b) =>
    b.addEventListener("click", () =>
      fetch(`/api/ptz/${cam.id}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: Number(b.dataset.x || 0), y: Number(b.dataset.y || 0) }) }).catch(() => {})
    )
  );
  node.querySelector(".snap").addEventListener("click", () => window.open(`/api/snapshot/${cam.id}`, "_blank"));
  node.querySelector(".rec").addEventListener("click", () => openRecordings(cam));
  node.querySelector(".full").addEventListener("click", () => node.querySelector(".video").requestFullscreen?.());
  node.querySelector(".del").addEventListener("click", async () => {
    if (!confirm(`Remove ${cam.name || cam.id}? (recordings on disk are kept)`)) return;
    await fetch(`/api/cameras/${cam.id}`, { method: "DELETE" });
    render();
  });
  return node;
}

async function refreshStatus() {
  await Promise.all(
    [...grid.querySelectorAll(".tile")].map(async (t) => {
      try {
        const s = await api(`/api/status/${t.dataset.id}`);
        t.querySelector(".dot").className = "dot " + (s.online ? "live" : "off");
        t.querySelector(".recbadge").hidden = !s.recording;
      } catch {
        t.querySelector(".dot").className = "dot off";
      }
    })
  );
}

// ---- recordings + archive modal --------------------------------------------
async function openRecordings(cam) {
  current = cam;
  recTitle.textContent = `Recordings — ${cam.name || cam.id}`;
  recPlayer.hidden = true;
  recPlayer.removeAttribute("src");
  formatBtn.hidden = !cam.hasSd;
  archiveBtn.hidden = !cam.canArchive;
  recList.innerHTML = arcList.innerHTML = `<p class="muted">Loading…</p>`;
  recDlg.showModal();
  await Promise.all([loadClips(), loadSched()]);
}

function clipRow(dir, c) {
  const row = document.createElement("div");
  row.className = "clip";
  row.innerHTML = `
    <button class="btn ghost play">▶</button>
    <span class="clip-meta"><b>${fmtTime(c.mtime)}</b><span class="muted">${c.file} · ${fmtBytes(c.size)}</span></span>
    <a class="btn ghost" href="/rec/${current.id}/${dir}${c.file}" download title="Download">⤓</a>
    ${dir ? "" : '<button class="btn ghost del" title="Delete">✕</button>'}`;
  row.querySelector(".play").onclick = () => {
    recPlayer.src = `/rec/${current.id}/${dir}${c.file}`;
    recPlayer.hidden = false;
    recPlayer.play().catch(() => {});
    recPlayer.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const del = row.querySelector(".del");
  if (del) del.onclick = async () => {
    if (!confirm("Delete this clip?")) return;
    await fetch(`/api/recordings/${current.id}/${c.file}`, { method: "DELETE" });
    loadClips();
  };
  return row;
}

async function loadClips() {
  try {
    const { clips, archived } = await api(`/api/recordings/${current.id}`);
    recCount.textContent = `(${clips.length})`;
    arcCount.textContent = `(${archived.length})`;
    recList.innerHTML = "";
    if (!clips.length) recList.innerHTML = `<p class="muted">No server recordings yet. Enable “Record live to server”.</p>`;
    else clips.forEach((c) => recList.appendChild(clipRow("", c)));
    arcList.innerHTML = "";
    if (!archived.length) arcList.innerHTML = `<p class="muted">No files pulled from the camera SD yet.</p>`;
    else archived.forEach((c) => arcList.appendChild(clipRow("sd/", c)));
  } catch (e) {
    recList.innerHTML = `<p class="muted">Error: ${e.message}</p>`;
  }
}

async function loadSched() {
  try {
    const s = await api("/api/scheduler");
    const c = s.cameras?.[current.id] || {};
    const fmt = c.lastFormatResult;
    recSched.innerHTML =
      `Archive every <b>${s.archiveEveryMin}m</b> · last archive <b>${ago(c.lastArchive)}</b>` +
      (current.autoFormat ? ` · auto-format <b>on</b> · last format <b>${ago(c.lastFormat)}</b>` : ` · auto-format <b>off</b>`) +
      (fmt && !fmt.formatted && fmt.reason ? `<br><span class="warn">last format skipped: ${fmt.reason}</span>` : "");
  } catch {
    recSched.textContent = "";
  }
}

archiveBtn.onclick = async () => {
  archiveBtn.disabled = true; archiveBtn.textContent = "Archiving…";
  const r = await api(`/api/archive/${current.id}`, { method: "POST" });
  archiveBtn.disabled = false; archiveBtn.textContent = "Archive now";
  if (r.failed?.length) alert(`Archived ${r.downloaded || 0}, ${r.failed.length} failed.`);
  await Promise.all([loadClips(), loadSched()]);
};

formatBtn.onclick = async () => {
  if (!confirm(`Safe-format SD of ${current.name || current.id}?\nThe server will archive + verify ALL footage first, and only format if everything is safely saved.`)) return;
  formatBtn.disabled = true; formatBtn.textContent = "Verifying…";
  const r = await api(`/api/format/${current.id}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: current.id }),
  });
  formatBtn.disabled = false; formatBtn.textContent = "Safe-format SD now";
  alert(r.formatted ? "✅ Verified and formatted." : "⚠️ Not formatted — " + (r.reason || r.error || "unknown"));
  await Promise.all([loadClips(), loadSched()]);
};

wipeBtn.onclick = async () => {
  if (!confirm(`Wipe ALL server footage for ${current.name || current.id}? Cannot be undone.`)) return;
  await fetch(`/api/recordings/${current.id}/wipe`, { method: "POST" });
  loadClips();
};

recClose.onclick = () => { recPlayer.pause?.(); recDlg.close(); };
recDlg.addEventListener("close", () => { recPlayer.pause?.(); recPlayer.removeAttribute("src"); });

// ---- discover ---------------------------------------------------------------
const sanitizeId = (s) => (s || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");

function discRow(dev) {
  const row = document.createElement("div");
  row.className = "clip";
  const octet = dev.ip.split(".").pop();
  if (dev.url) {
    row.innerHTML = `
      <span class="clip-meta"><b>${dev.ip}</b><span class="muted">RTSP found${dev.xaddr ? " · ONVIF" : ""}${dev.video ? " · video" : ""}</span></span>
      <input class="dname" placeholder="name" value="Cam ${octet}" />
      <button class="btn add">Add</button>`;
    row.querySelector(".add").onclick = async (e) => {
      const name = row.querySelector(".dname").value.trim() || dev.ip;
      const body = { id: sanitizeId(name) || `cam_${dev.ip.replaceAll(".", "_")}`, name, rtsp: dev.url, record: true };
      if (dev.xaddr) body.onvif = { host: dev.ip, port: 80, user: dUser.value.trim(), pass: dPass.value };
      const res = await fetch("/api/cameras", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { alert("Error: " + (r.error || res.status)); return; }
      e.target.textContent = "Added ✓"; e.target.disabled = true;
      render();
    };
  } else {
    const note = dev.open ? dev.note || "needs credentials" : dev.note || "no RTSP";
    row.innerHTML = `
      <span class="clip-meta"><b>${dev.ip}</b><span class="muted">${dev.xaddr ? "ONVIF · " : ""}${note}</span></span>
      <button class="btn ghost retest">Find RTSP</button>`;
    row.querySelector(".retest").onclick = async (e) => {
      e.target.textContent = "…"; e.target.disabled = true;
      const r = await api("/api/discover/rtsp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip: dev.ip, user: dUser.value.trim(), pass: dPass.value }) });
      row.replaceWith(discRow({ ...dev, ...r }));
    };
  }
  return row;
}

onvifScan.onclick = async () => {
  discStatus.textContent = "Scanning ONVIF (4s)…"; discList.innerHTML = "";
  try {
    const { devices } = await api("/api/discover");
    discStatus.textContent = devices.length ? `${devices.length} device(s) found.` : "No ONVIF devices found — try subnet scan.";
    devices.forEach((d) => discList.appendChild(discRow(d)));
  } catch (e) { discStatus.textContent = "Error: " + e.message; }
};

subnetScan.onclick = async () => {
  const subnet = subnetInput.value.trim();
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) return alert("Enter a subnet like 192.168.1");
  discStatus.textContent = `Scanning ${subnet}.1-254 for RTSP… (~30s)`; discList.innerHTML = "";
  try {
    const { results } = await api("/api/discover/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subnet, user: dUser.value.trim(), pass: dPass.value }) });
    discStatus.textContent = results.length ? `${results.length} host(s) with :554 open.` : "No open RTSP hosts found.";
    results.forEach((d) => discList.appendChild(discRow(d)));
  } catch (e) { discStatus.textContent = "Error: " + e.message; }
};

discoverBtn.addEventListener("click", () => { discList.innerHTML = ""; discStatus.textContent = ""; discDlg.showModal(); });
discClose.onclick = () => discDlg.close();

// ---- list / add -------------------------------------------------------------
async function render() {
  cameras = await api("/api/cameras");
  grid.innerHTML = "";
  if (!cameras.length) { grid.innerHTML = `<div class="empty">No cameras yet. Click “+ Add camera”.</div>`; return; }
  for (const cam of cameras) grid.appendChild(tileFor(cam));
  refreshStatus();
}

colsSel.addEventListener("change", () => (grid.className = `grid cols-${colsSel.value}`));
addBtn.addEventListener("click", () => addDlg.showModal());
addForm.addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  const f = new FormData(addForm);
  const body = { id: f.get("id").trim(), name: f.get("name").trim(), rtsp: f.get("rtsp").trim(), record: f.get("record") === "on" };
  if (f.get("ohost")) body.onvif = { host: f.get("ohost").trim(), port: Number(f.get("oport")) || 80, user: f.get("ouser").trim(), pass: f.get("opass") };
  const sd = {};
  if (f.get("sdlist")) sd.listUrl = f.get("sdlist").trim();
  if (f.get("sddl")) sd.downloadUrl = f.get("sddl").trim();
  if (f.get("sdformat")) sd.formatUrl = f.get("sdformat").trim();
  if (f.get("sdinfo")) sd.infoUrl = f.get("sdinfo").trim();
  if (Object.keys(sd).length) body.sd = sd;
  if (f.get("autoformat") === "on") body.autoFormat = { enabled: true, everyHours: Number(f.get("fhours")) || 24 };
  const res = await fetch("/api/cameras", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.json().catch(() => ({})); alert("Error: " + (err.error || res.status)); return; }
  addForm.reset();
  render();
});

cfg = await api("/api/config");
await render();
setInterval(refreshStatus, 10000);
