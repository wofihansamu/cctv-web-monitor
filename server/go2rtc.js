// Thin client for the go2rtc REST API.
// We register each camera's RTSP source as a named go2rtc stream; go2rtc then
// hands the browser a low-latency WebRTC feed (with MSE/HLS fallback) at
// /api/ws?src=<id>. This is the open-standard equivalent of the X-IOT app's
// StartPPPPLivestream + callBaceVideoData decode pipeline.

const GO2RTC_URL = process.env.GO2RTC_URL || "http://localhost:1984";

async function call(path, opts = {}) {
  const res = await fetch(`${GO2RTC_URL}${path}`, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`go2rtc ${opts.method || "GET"} ${path} -> ${res.status} ${body}`);
  }
  return res;
}

// Add or replace a stream. go2rtc keys streams by name; re-PUT updates the source.
export async function registerStream(id, src) {
  const qs = new URLSearchParams({ name: id, src });
  await call(`/api/streams?${qs}`, { method: "PUT" });
}

export async function deleteStream(id) {
  const qs = new URLSearchParams({ src: id });
  await call(`/api/streams?${qs}`, { method: "DELETE" }).catch(() => {});
}

// Current health/producer info for a stream (used for the status dots).
export async function streamInfo(id) {
  const qs = new URLSearchParams({ src: id });
  const res = await call(`/api/streams?${qs}`);
  return res.json();
}

// Single JPEG frame straight from go2rtc — used for snapshots and poster images.
export async function frameJpeg(id) {
  const qs = new URLSearchParams({ src: id });
  const res = await call(`/api/frame.jpeg?${qs}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function waitForGo2rtc(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await call(`/api/streams`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`go2rtc not reachable at ${GO2RTC_URL}`);
}
