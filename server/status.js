// P2P status helpers.
//
// The bridge harness prints one parseable line per status callback:
//   STATUS <uid> <type> <param>
// where <param> is the vendor PPPP status code. parseStatus() turns that into
// a UI-friendly state. producerOnline() answers the simpler, authoritative
// question the status dots actually use: is go2rtc currently receiving media
// for this stream (works for both pushed p2p producers and pulled RTSP ones).

// PPPP status code -> coarse UI state.
const PPPP_STATE = {
  0: "connecting", // CONNECTING
  1: "connecting", // INITIALING
  2: "online", // ON_LINE
  3: "offline", // CONNECT_FAILED
  4: "offline", // DISCONNECT
  5: "invalid", // INVALID_ID
  6: "offline", // DEVICE_NOT_ON_LINE
  7: "timeout", // CONNECT_TIMEOUT
  8: "offline", // CONNECT_ERRER
  110: "offline", // OTHER_LOGIN (another client took the session)
  255: "unknown", // UNKNOWN
};

export function statusLabel(code) {
  return PPPP_STATE[code] ?? "unknown";
}

// Parse a `STATUS <uid> <type> <param>` line. Returns null for anything else.
export function parseStatus(line) {
  if (typeof line !== "string") return null;
  const m = line.trim().match(/^STATUS\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s*$/);
  if (!m) return null;
  const uid = m[1];
  const type = Number(m[2]);
  const code = Number(m[3]);
  return { uid, type, code, state: statusLabel(code) };
}

// Is a go2rtc stream currently receiving media? Accepts the /api/streams?src=
// info object. True when any producer is actively connected or has media
// receivers / received bytes — covering both pulled (state:"connected") and
// pushed (receivers[]/bytes_recv) producers.
export function producerOnline(info) {
  const prods = info?.producers;
  if (!Array.isArray(prods)) return false;
  return prods.some(
    (p) =>
      p?.state === "connected" ||
      !!p?.url ||
      (Array.isArray(p?.receivers) && p.receivers.length > 0) ||
      (typeof p?.bytes_recv === "number" && p.bytes_recv > 0)
  );
}
