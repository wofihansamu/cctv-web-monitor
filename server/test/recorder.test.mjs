import { test } from "node:test";
import assert from "node:assert/strict";
import { recordSource } from "../recorder.js";

test("recordSource: rtsp cameras use their url; p2p cameras record go2rtc's re-served RTSP", () => {
  // RTSP/ONVIF camera → its own url
  assert.equal(recordSource({ id: "a", rtsp: "rtsp://cam/stream1" }), "rtsp://cam/stream1");
  // P2P camera → go2rtc re-serves the pushed stream at rtsp://host:8554/<id>
  assert.equal(recordSource({ id: "xiotcam", p2p: { uid: "U" } }), "rtsp://127.0.0.1:8554/xiotcam");
  // rtsp wins if somehow both present
  assert.equal(recordSource({ id: "x", rtsp: "rtsp://a", p2p: { uid: "U" } }), "rtsp://a");
  // nothing recordable
  assert.equal(recordSource({ id: "b" }), null);
  assert.equal(recordSource(null), null);
});
