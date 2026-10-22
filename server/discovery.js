// Camera discovery for the server + the CLI probe tool.
// ONVIF WS-Discovery (multicast) + RTSP URL probing. Dependency-free.
// Runs on the host/container LAN — docker-compose uses host networking so the
// multicast reaches your cameras. The vendor cloud and the P2P UID are never
// touched; this only inspects your own network.

import dgram from "node:dgram";
import net from "node:net";

export const COMMON_PATHS = [
  "/", "/live/ch0", "/live/ch00_0", "/live/0", "/live/main", "/live/av0",
  "/11", "/12", "/ch0_0.264", "/stream1", "/stream0", "/video1", "/av0_0",
  "/h264/ch1/main/av_stream", "/cam/realmonitor?channel=1&subtype=0",
  "/onvif1", "/onvif/profile1/media.smp", "/Streaming/Channels/101",
];
export const DEFAULT_CREDS = [["admin", ""], ["admin", "admin"], ["admin", "888888"], ["admin", "123456"], ["admin", "6666666"]];

export function rtspDescribe(host, port, path, user, pass, timeout = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout });
    let buf = "";
    const done = (r) => { try { sock.destroy(); } catch {} resolve(r); };
    sock.on("connect", () => {
      const auth = user != null ? `Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}\r\n` : "";
      sock.write(`DESCRIBE rtsp://${host}:${port}${path} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: probe\r\nAccept: application/sdp\r\n${auth}\r\n`);
    });
    sock.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/^RTSP\/1\.0 (\d{3}) (.*)/);
      if (m) done({ status: Number(m[1]), msg: m[2].trim(), sdpHasVideo: /m=video/i.test(buf), digest: /WWW-Authenticate:\s*Digest/i.test(buf) });
    });
    sock.on("timeout", () => done({ status: 0, msg: "timeout" }));
    sock.on("error", (e) => done({ status: 0, msg: e.code || e.message }));
  });
}

export function portOpen(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("timeout", () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(false));
  });
}

// Try common RTSP URLs/creds on one IP. Returns a structured result.
export async function probeRtsp(ip, user, pass) {
  if (!(await portOpen(ip, 554))) return { ip, open: false, note: "port 554 closed (no RTSP)" };
  const credList = user != null && user !== "" ? [[user, pass ?? ""]] : [[null, null], ...DEFAULT_CREDS];
  let authSeen = false;
  for (const path of COMMON_PATHS) {
    for (const [u, p] of credList) {
      const r = await rtspDescribe(ip, 554, path, u, p);
      if (r.status === 200) {
        const url = `rtsp://${u != null ? `${encodeURIComponent(u)}:${encodeURIComponent(p)}@` : ""}${ip}:554${path}`;
        return { ip, open: true, url, path, user: u, pass: p, video: r.sdpHasVideo };
      }
      if (r.status === 401) { authSeen = true; break; }
    }
  }
  return { ip, open: true, note: authSeen ? "RTSP present but needs correct user/pass" : "port 554 open but no common path matched" };
}

// ONVIF WS-Discovery. Resolves to [{ip, xaddr}].
export function discover(timeout = 4000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const uuid = "urn:uuid:" + Math.random().toString(16).slice(2);
    const probe =
      `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>${uuid}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
    const map = new Map();
    sock.on("message", (msg, rinfo) => {
      const s = msg.toString();
      const xaddr = [...s.matchAll(/<[^>]*XAddrs>([^<]+)</g)].map((m) => m[1]).join(" ").trim();
      if (!map.has(rinfo.address)) map.set(rinfo.address, { ip: rinfo.address, xaddr });
    });
    sock.on("error", () => { try { sock.close(); } catch {} resolve([]); });
    sock.bind(() => {
      sock.setBroadcast(true);
      try { sock.setMulticastTTL(2); } catch {}
      sock.send(probe, 3702, "239.255.255.250");
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...map.values()]); }, timeout);
  });
}

// Scan a /24 subnet (e.g. "192.168.1") for open :554, then probe each.
export async function scanSubnet(subnet, user, pass, concurrency = 32) {
  const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  const open = [];
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    const res = await Promise.all(batch.map(async (ip) => ((await portOpen(ip, 554, 500)) ? ip : null)));
    open.push(...res.filter(Boolean));
  }
  const out = [];
  for (const ip of open) out.push(await probeRtsp(ip, user, pass));
  return out;
}
