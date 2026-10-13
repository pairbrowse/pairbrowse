// The capture page (ui/capture, plans/550-capture.md): one capture core (capture.js, record.js)
// under two transports. Part 1 runs in Node with stand-ins for WebRTC and tab capture: the
// native transport's calls, checks and limits (the helper's liveview/capture.mjs and
// daemon/recorder.mjs), and the extension transport's ops as the offscreen document has always
// answered them. Part 2 renders the page over the fake helper and the window.pairbrowse shim
// (PAIRBROWSE_TEST_RUNTIME): the hello, a share's offer and a recording, end to end in a browser,
// with tab capture stood in by a canvas.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageTest } from "./helpers/ui-page.mjs";

// ---- Part 1: Node, with stand-ins ----

const gum = []; // the getUserMedia calls
let sdpSize = 400;
const track = (kind) => ({ kind, stopped: false, stop() { this.stopped = true; }, addEventListener() {}, applyConstraints: async () => {} });
Object.defineProperty(globalThis.navigator, "mediaDevices", { configurable: true, value: {
  getUserMedia: async (c) => {
    gum.push(c);
    const v = track("video"), a = track("audio");
    return { getTracks: () => [v, a], getVideoTracks: () => [v], getAudioTracks: () => [a] };
  },
} });
globalThis.AudioContext = class { destination = {}; createMediaStreamSource() { return { connect() {} }; } close() { return Promise.resolve(); } };
const pcs = [];
globalThis.RTCPeerConnection = class {
  constructor(config) { this.config = config; this.iceGatheringState = "complete"; this.closed = false; this.remote = null; pcs.push(this); }
  addTrack() { return { getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} }; }
  createDataChannel() { this.dc = {}; return this.dc; }
  addEventListener() {}
  async createOffer() { return { type: "offer", sdp: "v=0\r\n" + "a".repeat(sdpSize) }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remote = d; }
  close() { this.closed = true; }
};

const native = await import("../ui/capture/transport-native.js");
const ext = await import("../ui/capture/transport-extension.js");
const { CAPTURE_VALUE_MAX, CAPTURE_SDP_MAX, CAPTURE_ERROR_MAX, PAGE_CHUNK_BYTES, createNativeCapture, bounded, caps } = native;

// The helper's own limits, from the helper lane (scripts/liveview/capture.mjs, daemon/recorder.mjs).
test("the native transport's limits are the helper's", () => {
  assert.equal(CAPTURE_VALUE_MAX, 1_500_000);
  assert.equal(CAPTURE_SDP_MAX, 100_000);
  assert.equal(CAPTURE_ERROR_MAX, 300);
  assert.equal(PAGE_CHUNK_BYTES, 1024 * 1024);
});

// A window.pairbrowse for Node: the session's grant and the calls made.
function fakePb({ streamId = (t) => `stream-${t}` } = {}) {
  const calls = [];
  const pb = {
    session: {
      helper: async () => ({ origin: "", key: "" }),
      grantTabCapture: async (targetId, audio) => { calls.push(["grantTabCapture", targetId, audio]); return { streamId: streamId(targetId) }; },
    },
    tabs: { list: async () => ({ tabs: [] }), addObserver: () => () => {} },
    windows: { list: async () => ({ windows: [] }), addObserver: () => () => {} },
  };
  return { pb, calls };
}

test("hello caps: share needs WebRTC and the browser's grant, record needs MediaRecorder and a track reader", () => {
  const { pb } = fakePb();
  const all = { RTCPeerConnection: function () {}, MediaRecorder: function () {}, MediaStreamTrackProcessor: function () {} };
  assert.deepEqual(caps(pb, all), { share: true, record: true });
  assert.deepEqual(caps({ session: {} }, all), { share: false, record: true }, "no grantTabCapture: no share");
  assert.deepEqual(caps(pb, { MediaRecorder: all.MediaRecorder }), { share: false, record: false });
});

test("a call: { n, value } or { n, error }; anything else is no call", async () => {
  const { pb } = fakePb();
  const core = createNativeCapture(pb);
  assert.equal(await core.call(null), null);
  assert.equal(await core.call([]), null);
  assert.equal(await core.call({ to: "share", op: "peers" }), null, "no n");
  assert.equal(await core.call({ n: 0, to: "share", op: "peers" }), null);
  assert.equal(await core.call({ n: 1.5, to: "share", op: "peers" }), null);
  assert.deepEqual(await core.call({ n: 1, to: "share", op: "peers" }), { n: 1, value: [] });
  assert.deepEqual(await core.call({ n: 2, to: "elsewhere", op: "peers" }), { n: 2, error: "no such capture call" });
  assert.deepEqual(await core.call({ n: 3, to: "share", op: "nope" }), { n: 3, value: { error: "unknown" } });
  assert.deepEqual(await core.call({ n: 4, to: "record", op: "nope" }), { n: 4, value: { error: "unknown" } });
  // A call that throws: the reply's own error, cut to the helper's limit.
  const thrower = createNativeCapture({ ...pb, session: { grantTabCapture: async () => { throw new Error("x".repeat(1000)); } } });
  const r = await thrower.call({ n: 5, to: "share", op: "offer", peer: "p", tabId: "T1", frame: { w: 640, h: 400 } });
  assert.equal(r.n, 5);
  assert.equal(r.error.length, CAPTURE_ERROR_MAX);
});

test("an offer without a capture asks the browser for the tab once (with sound); the next offer reuses it", async () => {
  const { pb, calls } = fakePb();
  const core = createNativeCapture(pb);
  gum.length = 0;
  const a = await core.call({ n: 1, to: "share", op: "offer", peer: "pa", tabId: "TA", frame: { w: 640, h: 400 }, ice: [{ urls: "stun:x" }] });
  assert.match(a.value.sdp, /^v=0/);
  assert.deepEqual(calls, [["grantTabCapture", "TA", true]]);
  assert.equal(gum.length, 1);
  assert.equal(gum[0].video.mandatory.chromeMediaSourceId, "stream-TA");
  assert.equal(gum[0].audio.mandatory.chromeMediaSource, "tab");
  assert.equal(gum[0].video.mandatory.maxWidth, 640);
  assert.deepEqual(pcs.at(-1).config.iceServers, [{ urls: "stun:x" }]);
  const b = await core.call({ n: 2, to: "share", op: "offer", peer: "pb", tabId: "TA", frame: { w: 640, h: 400 } });
  assert.match(b.value.sdp, /^v=0/);
  assert.equal(calls.length, 1, "one grant per capture");
  assert.equal(gum.length, 1, "one capture per tab");
  assert.deepEqual((await core.call({ n: 3, to: "share", op: "has", tabId: "TA" })).value, true);
  assert.deepEqual((await core.call({ n: 4, to: "share", op: "peers" })).value, ["pa", "pb"]);
  // The joiner's answer, then both go; the capture ends with the last peer.
  assert.deepEqual((await core.call({ n: 5, to: "share", op: "answer", peer: "pa", sdp: "v=0 answer" })).value, true);
  assert.deepEqual(pcs.at(-2).remote, { type: "answer", sdp: "v=0 answer" });
  assert.deepEqual((await core.call({ n: 6, to: "share", op: "answer", peer: "nobody", sdp: "v=0" })).value, { error: "no such peer" });
  assert.deepEqual((await core.call({ n: 7, to: "share", op: "resize", tabId: "TA", frame: { w: 800, h: 500 } })).value, true);
  await core.call({ n: 8, to: "share", op: "stop", peer: "pa" });
  assert.equal((await core.call({ n: 9, to: "share", op: "has", tabId: "TA" })).value, true, "pb still watches");
  await core.call({ n: 10, to: "share", op: "stop", peer: "pb" });
  assert.equal((await core.call({ n: 11, to: "share", op: "has", tabId: "TA" })).value, false);
});

test("a tab the browser refuses (a chrome page, another profile's) is no capture, and nothing is asked of the page", async () => {
  const { pb, calls } = fakePb({ streamId: () => null });
  const core = createNativeCapture(pb);
  gum.length = 0;
  const r = await core.call({ n: 1, to: "share", op: "offer", peer: "px", tabId: "TSETTINGS", frame: { w: 640, h: 400 } });
  assert.deepEqual(r, { n: 1, value: { error: "the browser didn't let that tab be captured" } });
  assert.equal(calls.length, 1);
  assert.equal(gum.length, 0);
  assert.deepEqual((await core.call({ n: 2, to: "share", op: "peers" })).value, []);
});

test("the helper's arguments are checked before anything is captured", async () => {
  const { pb, calls } = fakePb();
  const core = createNativeCapture(pb);
  const bad = [
    { peer: "", tabId: "T", frame: { w: 640, h: 400 } },
    { peer: "p", tabId: 7, frame: { w: 640, h: 400 } },
    { peer: "p", tabId: "T".repeat(200), frame: { w: 640, h: 400 } },
    { peer: "p", tabId: "T", frame: { w: 640.5, h: 400 } },
    { peer: "p", tabId: "T", frame: { w: 640, h: 99_999 } },
    { peer: "p", tabId: "T" },
  ];
  for (const [i, m] of bad.entries()) {
    const r = await core.call({ n: i + 1, to: "share", op: "offer", ...m });
    assert.match(r.value.error, /an offer is/, JSON.stringify(m));
  }
  assert.equal(calls.length, 0);
  assert.match((await core.call({ n: 20, to: "share", op: "answer", peer: "p", sdp: "x".repeat(CAPTURE_SDP_MAX + 1) })).value.error, /an answer is/);
  assert.match((await core.call({ n: 21, to: "share", op: "resize", tabId: "T", frame: null })).value.error, /a resize is/);
});

test("an offer past the helper's SDP limit is refused and its peer closed", async () => {
  const { pb } = fakePb();
  const core = createNativeCapture(pb);
  sdpSize = CAPTURE_SDP_MAX + 10;
  try {
    const r = await core.call({ n: 1, to: "share", op: "offer", peer: "big", tabId: "TBIG", frame: { w: 640, h: 400 } });
    assert.deepEqual(r, { n: 1, value: { error: "the offer is too large" } });
    assert.equal(pcs.at(-1).closed, true);
    assert.deepEqual((await core.call({ n: 2, to: "share", op: "peers" })).value, []);
    assert.equal((await core.call({ n: 3, to: "share", op: "has", tabId: "TBIG" })).value, false, "its capture ended with it");
  } finally { sdpSize = 400; }
});

test("bounded: every answer fits the helper's reply checks", () => {
  assert.deepEqual(bounded(true), { value: true });
  assert.deepEqual(bounded(undefined), {});
  assert.deepEqual(bounded("x".repeat(CAPTURE_VALUE_MAX)), { value: "x".repeat(CAPTURE_VALUE_MAX) });
  assert.deepEqual(bounded("x".repeat(CAPTURE_VALUE_MAX + 1)), { error: "the answer is too large" });
  assert.deepEqual(bounded({ sdp: "x".repeat(CAPTURE_SDP_MAX + 1) }), { error: "the offer is too large" });
  assert.deepEqual(bounded({ list: "x".repeat(CAPTURE_VALUE_MAX) }), { error: "the answer is too large" });
  assert.equal(bounded({ error: "e".repeat(1000) }).value.error.length, CAPTURE_ERROR_MAX);
  const cyclic = {}; cyclic.self = cyclic;
  assert.deepEqual(bounded(cyclic), { error: "the answer can't be sent" });
});

test("record calls with nothing recording: the record core's answers, the ask bounded first", async () => {
  const { pb } = fakePb();
  const core = createNativeCapture(pb);
  // Nothing recorded: record.js answers so, after the transport bounded the ask.
  assert.deepEqual((await core.call({ n: 1, to: "record", op: "chunk", offset: -5, size: 64 * 1024 * 1024 })).value, { error: "nothing recorded" });
  assert.deepEqual((await core.call({ n: 2, to: "record", op: "state" })).value, { recording: false });
  assert.equal((await core.call({ n: 3, to: "record", op: "labels", labels: {} })).value, false, "not recording: the helper ends its side");
  assert.deepEqual((await core.call({ n: 4, to: "record", op: "stop" })).value, { error: "not recording" });
  assert.deepEqual((await core.call({ n: 5, to: "record", op: "start" })).value, { error: "no tab in front" });
  assert.equal(core.recording(), false);
});

// The extension's offscreen document: the worker's message shapes, answered as before the split.
test("the extension transport answers today's { to: \"share\", op } messages", async () => {
  let listener = null;
  ext.listen({ onMessage: { addListener: (fn) => { listener = fn; } } });
  assert.equal(typeof listener, "function");
  const send = (m) => new Promise((resolve) => { const kept = listener(m, {}, resolve); if (kept !== true) resolve("not kept"); });
  assert.equal(await send({ to: "elsewhere", op: "peers" }), "not kept", "other messages are left alone");
  assert.deepEqual(await send({ to: "share", op: "peers" }), []);
  assert.deepEqual(await send({ to: "share", op: "offer", peer: "e1", tabId: 42 }), { error: "no capture for that tab" }, "the worker mints the stream id");
  gum.length = 0;
  const o = await send({ to: "share", op: "offer", peer: "e1", tabId: 42, streamId: "sid-42", frame: { w: 800, h: 600 } });
  assert.match(o.sdp, /^v=0/);
  assert.equal(gum[0].video.mandatory.chromeMediaSourceId, "sid-42");
  assert.equal(await send({ to: "share", op: "has", tabId: 42 }), true);
  assert.equal(await send({ to: "share", op: "answer", peer: "e1", sdp: "v=0" }), true);
  assert.deepEqual(await send({ to: "share", op: "answer", peer: "zz", sdp: "v=0" }), { error: "no such peer" });
  assert.equal(await send({ to: "share", op: "resize", tabId: 42, frame: { w: 640, h: 480 } }), true);
  assert.deepEqual(await send({ to: "share", op: "take", ms: 0 }), []);
  assert.deepEqual(await send({ to: "share", op: "peers" }), ["e1"]);
  assert.deepEqual(await send({ to: "share", op: "recState" }), { recording: false });
  assert.deepEqual(await send({ to: "share", op: "recChunk", offset: 0, size: 10 }), { error: "nothing recorded" });
  assert.equal(await send({ to: "share", op: "stop", peer: "e1" }), true);
  assert.equal(await send({ to: "share", op: "has", tabId: 42 }), false);
  assert.equal(await send({ to: "share", op: "stopTab", tabId: 42 }), true);
  assert.deepEqual(await send({ to: "share", op: "nope" }), { error: "unknown" });
  // A throw inside an op is the answer's error, as before.
  const was = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async () => { throw new Error("Permission denied"); };
  try { assert.deepEqual(await send({ to: "share", op: "offer", peer: "e2", tabId: 43, streamId: "s", frame: { w: 8, h: 8 } }), { error: "Permission denied" }); }
  finally { navigator.mediaDevices.getUserMedia = was; }
});

test("the module split: no chrome.* in the core, one module entry, the worker's offscreen URL unchanged", () => {
  const src = (f) => readFileSync(new URL(`../ui/capture/${f}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const f of ["capture.js", "record.js", "transport-native.js"]) assert.doesNotMatch(src(f), /\bchrome\./, `${f} uses chrome.*`);
  for (const f of ["capture.js", "record.js"]) assert.doesNotMatch(src(f), /globalThis|pairbrowse\.|EventSource|fetch\(/, `${f} has transport code`);
  const html = readFileSync(new URL("../ui/capture/index.html", import.meta.url), "utf8");
  assert.deepEqual([...html.matchAll(/<script\b[^>]*>/g)].map(([t]) => t), ['<script type="module" src="main.js">']);
  const bg = readFileSync(new URL("../ui/background.js", import.meta.url), "utf8");
  assert.match(bg, /createDocument\(\{ url: "capture\/index\.html", reasons: \["USER_MEDIA"\]/);
});

// What joiners did comes in pieces that fit the helper's reply; the rest waits for the next take.
test("take: at most 200 items, within the helper's reply limit, the rest kept in order", async () => {
  const { pb } = fakePb();
  const core = createNativeCapture(pb);
  await core.call({ n: 1, to: "share", op: "offer", peer: "pt", tabId: "TT", frame: { w: 640, h: 400 } });
  const dc = pcs.at(-1).dc;
  const big = "k".repeat(19_000); // a data channel message is at most 20 000 characters
  for (let i = 0; i < 150; i++) dc.onmessage({ data: JSON.stringify({ t: "key", i, big }) });
  dc.onmessage({ data: "x".repeat(20_001) }); // too long: dropped
  const first = (await core.call({ n: 2, to: "share", op: "take", ms: 0 })).value;
  assert.ok(first.length > 0 && first.length < 150, `${first.length} items`);
  assert.ok(JSON.stringify(first).length <= CAPTURE_VALUE_MAX);
  assert.deepEqual(first.map((x) => x.ev.i), [...first.keys()]);
  let rest = [];
  for (let n = 3; rest.length + first.length < 150 && n < 20; n++) rest = rest.concat((await core.call({ n, to: "share", op: "take", ms: 0 })).value);
  assert.deepEqual(rest.map((x) => x.ev.i), Array.from({ length: 150 - first.length }, (_, i) => first.length + i), "nothing lost, in order");
  // The extension's take is as it was: up to 200 items, no size limit.
  for (let i = 0; i < 250; i++) dc.onmessage({ data: JSON.stringify({ i }) });
  const cap = await import("../ui/capture/capture.js");
  assert.equal((await cap.take({ ms: 0 })).length, 200);
  assert.equal((await cap.take({ ms: 0 })).length, 50);
  await core.call({ n: 30, to: "share", op: "stop", peer: "pt" });
});

// ---- Part 2: the page in a browser ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// In the page: tab capture stood in by a moving canvas (picture) and an oscillator (sound).
function fakeTabCapture() {
  window.__gum = [];
  navigator.mediaDevices.getUserMedia = async (c) => {
    window.__gum.push(c?.video?.mandatory?.chromeMediaSourceId || "");
    const canvas = document.createElement("canvas");
    canvas.width = c?.video?.mandatory?.maxWidth || 320;
    canvas.height = c?.video?.mandatory?.maxHeight || 200;
    const ctx = canvas.getContext("2d");
    let x = 0;
    const paint = () => { ctx.fillStyle = "#123"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = "#fff"; ctx.fillRect(x++ % canvas.width, 10, 20, 20); };
    paint();
    const stream = canvas.captureStream(30);
    const timer = setInterval(paint, 33);
    stream.getVideoTracks()[0].addEventListener("ended", () => clearInterval(timer));
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    ac.createOscillator().connect(dest);
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    return stream;
  };
  return true;
}

// The capture page's answers the fake helper got: by n, and the hellos.
const replies = (helper) => helper.posts.filter((p) => p.route === "capture" && p.rest[0] === "reply").map((p) => p.body);
async function ask(helper, n, data, ms = 8000) {
  helper.push("capture", { n, ...data });
  for (let i = 0; i < ms / 50; i++) {
    const r = replies(helper).find((b) => b.n === n);
    if (r) return r;
    await sleep(50);
  }
  return assert.fail(`no reply to capture call ${n} (${data.op})`);
}

describe("capture: hello on its own stream", () => pageTest("capture", async ({ helper, errors }) => {
  const streams = [...helper.streams].map((s) => s.kind);
  assert.ok(streams.includes("capture"), "events?page=capture");
  assert.ok(helper.streams.size === 1, "its own stream only");
  const hello = replies(helper).find((b) => b.hello === true);
  assert.deepEqual(hello, { hello: true, caps: { share: true, record: true } });
  assert.deepEqual(errors, []);
}));

describe("capture: a share's offer through the browser's grant", () => pageTest("capture", async ({ helper, inPage, shim }) => {
  await inPage(fakeTabCapture);
  const a = await ask(helper, 1, { to: "share", op: "offer", peer: "pa", tabId: "T11", frame: { w: 640, h: 400 }, ice: [] });
  assert.match(a.value?.sdp || "", /^v=0/, JSON.stringify(a));
  assert.ok(a.value.sdp.length <= 100_000);
  const b = await ask(helper, 2, { to: "share", op: "offer", peer: "pb", tabId: "T11", frame: { w: 640, h: 400 }, ice: [] });
  assert.match(b.value?.sdp || "", /^v=0/);
  const grants = (await shim.calls()).filter((c) => c.method === "grantTabCapture");
  assert.deepEqual(grants.map((c) => c.args), [["T11", true]], "one grant, with sound");
  assert.deepEqual(await inPage(() => window.__gum), ["stream-T11"]);
  assert.deepEqual((await ask(helper, 3, { to: "share", op: "peers" })).value, ["pa", "pb"]);
  assert.deepEqual((await ask(helper, 4, { to: "share", op: "take", ms: 10 })).value, []);
  await ask(helper, 5, { to: "share", op: "stop", peer: "pa" });
  await ask(helper, 6, { to: "share", op: "stop", peer: "pb" });
  assert.equal((await ask(helper, 7, { to: "share", op: "has", tabId: "T11" })).value, false);
}));

describe("capture: a recording follows the tab in front and comes back in pieces", () => pageTest("capture", { timeout: 90_000 }, async ({ helper, inPage, shim }) => {
  await inPage(fakeTabCapture);
  const start = await ask(helper, 1, { to: "record", op: "start", follow: "front", labels: { T11: { who: "Claude", color: "#e9763f", prefix: "Claude · " } }, scale: 1 });
  assert.match(start.value?.type || "", /^video\/(mp4|webm)$/, JSON.stringify(start));
  assert.equal(start.value.w, 1280);
  assert.equal(start.value.h, 840);
  await sleep(600);
  await shim.activate(12); // the person switches tabs: the video follows
  for (let i = 0; i < 40 && (await inPage(() => window.__gum.length)) < 2; i++) await sleep(50);
  assert.deepEqual(await inPage(() => window.__gum), ["stream-T11", "stream-T12"]);
  const st = await ask(helper, 2, { to: "record", op: "state" });
  assert.equal(st.value.recording, true);
  assert.equal(st.value.front, "T12");
  const labels = await ask(helper, 3, { to: "record", op: "labels", labels: {} });
  assert.equal(labels.value.full, false);
  await sleep(1200);
  const stop = await ask(helper, 4, { to: "record", op: "stop" }, 15_000);
  assert.ok(stop.value?.size > 0, JSON.stringify(stop));
  // A piece asked far past the page's limit comes at most PAGE_CHUNK_BYTES, as base64.
  const piece = await ask(helper, 5, { to: "record", op: "chunk", offset: 0, size: 8 * 1024 * 1024 }, 15_000);
  assert.equal(typeof piece.value, "string");
  assert.equal(Buffer.from(piece.value, "base64").length, Math.min(stop.value.size, 1024 * 1024));
  // After the stop no tab switch is followed: no new grant.
  const before = (await shim.calls()).filter((c) => c.method === "grantTabCapture").length;
  await shim.activate(11);
  await sleep(300);
  assert.equal((await shim.calls()).filter((c) => c.method === "grantTabCapture").length, before);
  assert.equal((await ask(helper, 6, { to: "record", op: "clear" })).value, true);
  assert.deepEqual((await ask(helper, 7, { to: "record", op: "state" })).value, { recording: false });
}));

describe("capture: a browser page in front is not recorded", () => pageTest("capture", { shim: { tabs: [
  { id: 13, index: 0, window: 1, title: "Settings", url: "chrome://settings", active: true, targetId: "T13", width: 1280, height: 800 },
], windows: [{ id: 1, focused: true, activeTab: 13 }], replies: { grantTabCapture: "" } } }, async ({ helper, inPage }) => {
  await inPage(fakeTabCapture);
  const r = await ask(helper, 1, { to: "record", op: "start" });
  assert.deepEqual(r.value, { error: "the tab in front can't be recorded" });
  assert.deepEqual(await inPage(() => window.__gum), []);
}));
