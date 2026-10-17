// The capture page's channel (liveview/capture.mjs) and where tabs are captured
// (daemon/capture.mjs): the extension, the browser's own capture page, or nowhere.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureChannel, CAPTURE_WAITING_MAX, CAPTURE_SDP_MAX, CAPTURE_ERROR_MAX } from "../scripts/liveview/capture.mjs";
import { createCaptureBackend, targetIdOf, NO_CAPTURE_RECORD, NO_CAPTURE_SHARE, RECORD_READY_MS } from "../scripts/daemon/capture.mjs";
import { createRecorder } from "../scripts/daemon/recorder.mjs";
import { tmpdir } from "node:os";

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
  const of = (browserPages, capturePages, env = {}) => createCaptureBackend({ browserPages: () => browserPages, capturePages: () => capturePages, panelCall: async () => null, channel: ch, env }).kind();
  assert.equal(of(false, false), "extension");
  assert.equal(of(false, true), "extension");
  assert.equal(of(true, false), null, "own pages, no capture page");
  assert.equal(of(true, true), null, "declared, but no hello yet");
  ch.reply({ hello: true, caps: { share: true, record: true } });
  assert.equal(of(true, true), "page");
  assert.equal(of(true, false), null, "a hello without the build declaring it");
  assert.equal(of(false, false, { PAIRBROWSE_TEST_NO_CAPTURE: "1" }), null, "tests: nowhere");
  assert.match(NO_CAPTURE_RECORD, /^Recording isn't available in this PairBrowse browser yet: it needs the browser's capture page, which comes with a later build\. Nothing was recorded\.$/);
  assert.match(NO_CAPTURE_SHARE, /join channel.*none while the tab shows card fields/);
});

test("in page mode share and record go to the channel with the tab's target id; else to the extension", async () => {
  const sent = [];
  const ch = createCaptureChannel({ send: (d) => sent.push(d) });
  const ext = [];
  let ownPages = true;
  const backend = createCaptureBackend({ browserPages: () => ownPages, capturePages: () => true, channel: ch, env: {}, panelCall: async (fn, arg) => { ext.push(arg); return 7; } });
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
  ownPages = false;
  assert.equal(await backend.tabRef(page), 7, "the extension's tab id");
  assert.deepEqual(ext, ["ABCDEF"]);
});

test("a tab that never answers: tabRef gives up within its bound; a tab's target is asked once", async () => {
  const backend = createCaptureBackend({ browserPages: () => true, capturePages: () => true, channel: { ready: () => true }, env: {}, panelCall: async () => 7 });
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

test("targetIdOf: one cached lookup for every caller; null when the tab fails or hangs, within its bound", async () => {
  let asked = 0;
  const page = { context: () => ({ newCDPSession: async () => ({ send: async () => { asked++; return { targetInfo: { targetId: "T2" } }; }, detach: async () => {} }) }) };
  assert.equal(await targetIdOf(page, 2000), "T2");
  const backend = createCaptureBackend({ browserPages: () => true, capturePages: () => true, channel: { ready: () => true }, env: {}, panelCall: async () => 7 });
  assert.equal(await backend.tabRef(page), "T2", "tabRef reuses the approvals' lookup");
  assert.equal(await targetIdOf(page), "T2");
  assert.equal(asked, 1, "asked once for every caller");
  const failing = { context: () => ({ newCDPSession: async () => { throw new Error("closed"); } }) };
  assert.equal(await targetIdOf(failing, 500), null);
  await assert.rejects(backend.tabRef(failing, 500), /the tab didn't answer/);
  const empty = { context: () => ({ newCDPSession: async () => ({ send: async () => ({}), detach: async () => {} }) }) };
  assert.equal(await targetIdOf(empty, 500), null);
  const hung = { context: () => ({ newCDPSession: async () => ({ send: () => new Promise(() => {}), detach: async () => {} }) }) };
  const t0 = Date.now();
  assert.equal(await targetIdOf(hung, 300), null);
  assert.ok(Date.now() - t0 < 1500, "bounded by its wait");
  const t1 = Date.now();
  assert.equal(await targetIdOf(hung, 60_000), null);
  assert.ok(Date.now() - t1 < 3500, "never longer than 3 s");
});

test("whenReady: true at a late hello, at once after it, false after its time or when the browser closes", async () => {
  const ch = createCaptureChannel({ send: () => {} });
  const t0 = Date.now();
  assert.equal(await ch.whenReady(60), false, "no hello: false after its time");
  assert.ok(Date.now() - t0 >= 50);
  const late = ch.whenReady(5000);
  setTimeout(() => ch.reply({ hello: true, caps: { share: true, record: true } }), 40);
  assert.equal(await late, true, "the hello ends the wait");
  assert.equal(await ch.whenReady(5000), true, "already said hello: at once");
  ch.reset();
  const closing = ch.whenReady(5000);
  ch.reset();
  assert.equal(await closing, false, "the browser closed: false");
  const many = Array.from({ length: CAPTURE_WAITING_MAX }, () => ch.whenReady(5000));
  assert.equal(await ch.whenReady(5000), false, "one more than the bound: false at once");
  ch.reset();
  assert.deepEqual(new Set(await Promise.all(many)), new Set([false]));
});

test("waitReady: the capture page's late hello is waited for; nothing is waited for where no capture page is declared", async () => {
  const ch = createCaptureChannel({ send: () => {} });
  const backend = (browserPages, capturePages, env = {}) => createCaptureBackend({ browserPages: () => browserPages, capturePages: () => capturePages, panelCall: async () => null, channel: ch, env });
  assert.equal(RECORD_READY_MS, 3000);
  assert.equal(await backend(false, false).waitReady(5000), "extension", "the extension: at once");
  let t0 = Date.now();
  assert.equal(await backend(true, false).waitReady(5000), null, "no capture page declared: nowhere at once");
  assert.equal(await backend(false, false, { PAIRBROWSE_TEST_NO_CAPTURE: "1" }).waitReady(5000), null);
  assert.ok(Date.now() - t0 < 500, "nothing waited for");
  const b = backend(true, true);
  t0 = Date.now();
  assert.equal(await b.waitReady(80), null, "declared, no hello within the wait: nowhere");
  assert.ok(Date.now() - t0 >= 70);
  const p = b.waitReady(5000);
  assert.equal(b.kind(), null, "kind() never waits (share's immediate fallback)");
  setTimeout(() => ch.reply({ hello: true, caps: { share: true, record: true } }), 50);
  assert.equal(await p, "page");
});

test("record waits for the capture page's late hello, then records through it", async () => {
  const sent = [];
  const ch = createCaptureChannel({ send: (d) => { sent.push(d); if (d.op === "start") setImmediate(() => ch.reply({ n: d.n, value: { type: "video/webm", w: 1280, h: 840 } })); } });
  const capture = createCaptureBackend({ browserPages: () => true, capturePages: () => true, panelCall: async () => { throw new Error("the extension isn't there"); }, channel: ch, env: {} });
  const rec = createRecorder({ call: async () => { throw new Error("the extension isn't there"); }, dir: () => tmpdir(), capture });
  setTimeout(() => ch.reply({ hello: true, caps: { share: true, record: true } }), 300);
  const t0 = Date.now();
  const r = await rec.start();
  assert.ok(!r.error, r.text);
  assert.ok(Date.now() - t0 >= 250, "it waited for the hello");
  assert.equal(rec.state().recording, true);
  assert.equal(sent.filter((d) => d.op === "start" && d.to === "record").length, 1);
  rec.browserClosed();
  ch.reset();
});

test("record still refuses after 3 s with no capture page, and asks nothing", async () => {
  const sent = [];
  const ch = createCaptureChannel({ send: (d) => sent.push(d) });
  let extension = 0;
  const capture = createCaptureBackend({ browserPages: () => true, capturePages: () => true, panelCall: async () => { extension++; }, channel: ch, env: {} });
  const rec = createRecorder({ call: async () => { extension++; }, dir: () => tmpdir(), capture });
  const t0 = Date.now();
  const r = await rec.start();
  const took = Date.now() - t0;
  assert.equal(r.error, true);
  assert.equal(r.text, NO_CAPTURE_RECORD);
  assert.ok(took >= RECORD_READY_MS - 50 && took < RECORD_READY_MS + 1500, `waited ${took} ms`);
  assert.deepEqual(sent, [], "nothing sent to a page");
  assert.equal(extension, 0, "nothing asked of the extension");
  assert.equal(rec.state().recording, false);
});
