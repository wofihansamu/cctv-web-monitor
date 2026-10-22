#!/usr/bin/env node
// CLI wrapper around server/discovery.js. Same detection the web UI uses.
// Run on a machine on the SAME network as the camera.
//
//   node tools/probe.mjs discover                 # ONVIF WS-Discovery
//   node tools/probe.mjs rtsp <ip> [user] [pass]  # try common RTSP URLs on one IP
//   node tools/probe.mjs scan <subnet> [user] [pass]   # e.g. scan 192.168.1

import { discover, probeRtsp, scanSubnet } from "../server/discovery.js";

const [cmd, arg, user, pass] = process.argv.slice(2);

if (cmd === "discover") {
  console.log("Listening for ONVIF cameras (WS-Discovery) for 4s...");
  const devices = await discover();
  if (!devices.length) console.log("  (none found — camera may not support ONVIF, or is on another subnet/VLAN)");
  for (const d of devices) {
    console.log(`  ✅ ONVIF device at ${d.ip}`);
    if (d.xaddr) console.log(`     service: ${d.xaddr}`);
  }
} else if (cmd === "rtsp" && arg) {
  console.log(`Probing RTSP on ${arg}...`);
  const r = await probeRtsp(arg, user, pass);
  console.log(r.url ? `  ✅ WORKS: ${r.url}  video=${r.video}` : `  ⚠️  ${r.note}`);
} else if (cmd === "scan" && arg) {
  console.log(`Scanning ${arg}.1-254 for open RTSP (554)...`);
  const res = await scanSubnet(arg, user, pass);
  if (!res.length) console.log("  no hosts with port 554 open.");
  for (const r of res) console.log(r.url ? `  ✅ ${r.url}  video=${r.video}` : `  ⚠️  ${r.ip}: ${r.note}`);
} else {
  console.log("usage:\n  node tools/probe.mjs discover\n  node tools/probe.mjs rtsp <ip> [user] [pass]\n  node tools/probe.mjs scan <subnet e.g. 192.168.1> [user] [pass]");
}
