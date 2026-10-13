// The capture page's channel (liveview/capture.mjs) and where tabs are captured
// (daemon/capture.mjs): the extension, the browser's own capture page, or nowhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureChannel, CAPTURE_WAITING_MAX, CAPTURE_SDP_MAX, CAPTURE_ERROR_MAX } from "../scripts/liveview/capture.mjs";
import { createCaptureBackend, NO_CAPTURE_RECORD, NO_CAPTURE_SHARE } from "../scripts/daemon/capture.mjs";

test("a call goes out as a capture event and resolves on its reply", async () => {
  const sent = [];
  const ch = createCaptureChannel({ send: (d) => sent.push(d) });
  const p = ch.call("share", { op: "offer", tabId: "AB" }, 2000);
  assert.deepEqual(sent, [{ op: "offer", tabId: "AB", n: 1, to: "share" }]);
  assert.equal(ch.reply({ n: 1, value: { sdp: "v=0" } }), true);
  assert.deepEqual(await p, { sdp: "v=0" });
  const q = ch.call("record", { op: "stop" }, 2000);
  assert.equal(ch.reply({ n: 2, error: "no tab" }), true);
  await assert.rejects(q, /no tab/);
  assert.equal(ch.waiting(), 0);
  await assert.rejects(ch.call("evaluate", {}), /no capture call/, "only share and record");
});

test("a call nobody answers is rejected after its time, and a late answer is dropped", async () => {
  const ch = createCaptureChannel({ send: () => {} });
  await assert.rejects(ch.call("share", {}, 30), /didn't answer/);
  assert.equal(ch.reply({ n: 1, value: true }), true, "late: accepted and dropped");
  assert.equal(ch.waiting(), 0);
});

test("the browser closing rejects every waiting call and forgets the hello", async () => {
  const ch = createCaptureChannel({ send: () => {} });
  assert.equal(ch.ready(), false);
  assert.equal(ch.reply({ hello: true, caps: { share: true, record: false } }), true);
  assert.equal(ch.ready(), true);
  assert.deepEqual(ch.caps(), { share: true, record: false });
  const a = ch.call("share", {}, 5000), b = ch.call("record", {}, 5000);
  ch.reset();
  await assert.rejects(a, /browser closed/);
  await assert.rejects(b, /browser closed/);
  assert.equal(ch.ready(), false);
});

test("bad replies are refused: n, error and sizes", async () => {
  const ch = createCaptureChannel({ send: () => {} });
  for (const bad of [null, [], "x", { n: 0 }, { n: -1 }, { n: 1.5 }, { n: "1" }, { n: 1, error: 3 }, { n: 1, error: "e".repeat(CAPTURE_ERROR_MAX + 1) }, { n: 1, value: { sdp: "s".repeat(CAPTURE_SDP_MAX + 1) } }, { n: 1, value: { sdp: 4 } }, { n: 1, value: "b".repeat(1_500_001) }]) {
    assert.equal(ch.reply(bad), false, JSON.stringify(bad)?.slice(0, 60));
  }
  // A recording's piece (base64 of 1 MB) fits.
  const p = ch.call("record", { op: "chunk" }, 2000);
  assert.equal(ch.reply({ n: 1, value: "b".repeat(1_400_000) }), true);
  assert.equal((await p).length, 1_400_000);
  // At most CAPTURE_WAITING_MAX waiting.
  const many = Array.from({ length: CAPTURE_WAITING_MAX }, () => ch.call("share", {}, 5000).catch(() => {}));
  await assert.rejects(ch.call("share", {}, 5000), /too many/);
  ch.reset();
  await Promise.all(many);
});

test("where tabs are captured: extension without own pages, the page once it said hello and the build declares it, else nowhere", () => {
  const ch = createCaptureChannel({ send: () => {} });
  const of = (chromePages, capturePages, env = {}) => createCaptureBackend({ chromePages: () => chromePages, capturePages: () => capturePages, panelCall: async () => null, channel: ch, env }).kind();
  assert.equal(of(false, false), "extension");
  assert.equal(of(false, true), "extension");
  assert.equal(of(true, false), null, "own pages, no capture page");
  assert.equal(of(true, true), null, "declared, but no hello yet");
  ch.reply({ hello: true, caps: { share: true, record: true } });
  assert.equal(of(true, true), "page");
  assert.equal(of(true, false), null, "a hello without the build declaring it");
  assert.equal(of(false, false, { PAIRBROWSE_TEST_NO_CAPTURE: "1" }), null, "tests: nowhere");
  assert.match(NO_CAPTURE_RECORD, /^Recording isn't available in this PairBrowse browser yet: it needs the browser's capture page, which comes with a later build\. Nothing was recorded\.$/);
  assert.match(NO_CAPTURE_SHARE, /join channel/);
});

test("in page mode share and record go to the channel with the tab's target id; else to the extension", async () => {
  const sent = [];
  const ch = createCaptureChannel({ send: (d) => sent.push(d) });
  const ext = [];
  let chrome = true;
  const backend = createCaptureBackend({ chromePages: () => chrome, capturePages: () => true, channel: ch, env: {}, panelCall: async (fn, arg) => { ext.push(arg); return 7; } });
  ch.reply({ hello: true, caps: { share: true, record: true } });
  const cdp = { send: async () => ({ targetInfo: { targetId: "ABCDEF" } }), detach: async () => {} };
  const page = { context: () => ({ newCDPSession: async () => cdp }) };
  assert.equal(await backend.tabRef(page), "ABCDEF", "the CDP target itself");
  const p = backend.share({ op: "offer", tabId: "ABCDEF" });
  assert.deepEqual(sent.at(-1), { op: "offer", tabId: "ABCDEF", n: 1, to: "share" });
  ch.reply({ n: 1, value: { sdp: "x" } });
  assert.deepEqual(await p, { sdp: "x" });
  const r = backend.record({ op: "start" });
  assert.equal(sent.at(-1).to, "record");
  ch.reply({ n: 2, value: { type: "video/webm" } });
  await r;
  assert.deepEqual(ext, [], "the extension isn't asked");
  chrome = false;
  assert.equal(await backend.tabRef(page), 7, "the extension's tab id");
  assert.deepEqual(ext, ["ABCDEF"]);
});

test("a tab that never answers: tabRef gives up within its bound; a tab's target is asked once", async () => {
  const backend = createCaptureBackend({ chromePages: () => true, capturePages: () => true, channel: { ready: () => true }, env: {}, panelCall: async () => 7 });
  const hung = { context: () => ({ newCDPSession: async () => ({ send: () => new Promise(() => {}), detach: async () => {} }) }) };
  const t0 = Date.now();
  await assert.rejects(backend.tabRef(hung, 300), /the tab didn't answer/);
  assert.ok(Date.now() - t0 < 2000, "bounded by the call's own wait");
  let asked = 0;
  const page = { context: () => ({ newCDPSession: async () => ({ send: async () => { asked++; return { targetInfo: { targetId: "T1" } }; }, detach: async () => {} }) }) };
  assert.equal(await backend.tabRef(page), "T1");
  assert.equal(await backend.tabRef(page), "T1");
  assert.equal(asked, 1, "the target id is kept for the page");
});
