import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, producerOnline } from "../status.js";

test("parseStatus maps PPPP status codes to UI states", () => {
  assert.deepEqual(parseStatus("STATUS XIOTB-021580-TJBSS 0 2"), {
    uid: "XIOTB-021580-TJBSS",
    type: 0,
    code: 2,
    state: "online",
  });
  assert.equal(parseStatus("STATUS XIOTB-021580-TJBSS 0 0").state, "connecting");
  assert.equal(parseStatus("STATUS XIOTB-021580-TJBSS 0 1").state, "connecting");
  assert.equal(parseStatus("STATUS XIOTB-021580-TJBSS 0 7").state, "timeout");
  assert.equal(parseStatus("STATUS XIOTB-021580-TJBSS 0 4").state, "offline");
  assert.equal(parseStatus("STATUS XIOTB-021580-TJBSS 0 6").state, "offline");
  assert.equal(parseStatus("STATUS XIOTB-021580-TJBSS 0 5").state, "invalid");
  assert.equal(parseStatus("STATUS XIOTB-021580-TJBSS 0 110").state, "offline");
  assert.equal(parseStatus("STATUS XIOTB-021580-TJBSS 0 255").state, "unknown");
});

test("parseStatus ignores non-STATUS and malformed lines", () => {
  assert.equal(parseStatus("[..] t=3s online=1"), null);
  assert.equal(parseStatus("STATUS only-two 2"), null);
  assert.equal(parseStatus(""), null);
  assert.equal(parseStatus(undefined), null);
});

test("producerOnline detects an active go2rtc producer (push and pull shapes)", () => {
  // push (our RTSP bridge): producer has receivers / bytes_recv, no state/url
  assert.equal(
    producerOnline({ producers: [{ format_name: "rtsp", receivers: [{ id: 2 }], bytes_recv: 1234 }] }),
    true
  );
  // pull (rtsp camera): go2rtc marks state connected
  assert.equal(producerOnline({ producers: [{ state: "connected" }] }), true);
  // declared but nothing flowing yet → offline
  assert.equal(producerOnline({ producers: [] }), false);
  assert.equal(producerOnline({ producers: null }), false);
  assert.equal(producerOnline({}), false);
  assert.equal(producerOnline(null), false);
  // a producer slot with no receivers and no bytes → offline
  assert.equal(producerOnline({ producers: [{ format_name: "rtsp", receivers: [] }] }), false);
});
