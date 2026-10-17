// Shared browser mode, on the host: the capture core. It captures a shared tab (picture and
// sound, tab capture) and sends it straight to each joiner's PairBrowse over WebRTC, peer to
// peer: the tunnel only carries the few messages that set the connection up. What the joiner does
// (pointer, keys) comes back on the same connection and waits here until the helper takes it (it
// alone decides what to replay, and where). No transport here: the extension's offscreen
// document asks through transport-extension.js (its worker, background.js), the PairBrowse
// browser's own capture page through transport-native.js (the helper's channel); main.js picks.
const tabs = new Map(); // tabId -> { stream, audio, frame: { w, h }, peers: Set, rec: recording uses it }
const making = new Map(); // tabId -> its capture being made: offers and a recording that ask together share it
const conns = new Map(); // peer -> { pc, tabId }
const inbox = []; // { peer, ev } or { peer, state }, until the helper takes them
const stopped = []; // fn(tabId) for each tab whose capture ends (record.js forgets its picture)
let wake = null;
const tell = (item) => {
  if (inbox.length > 2000) inbox.splice(0, inbox.length - 1000); // nobody is taking them
  inbox.push(item);
  if (wake) { wake(); wake = null; }
};

// The captures, for record.js (it records the same tabs a share captures; one capture per tab).
export const captured = (tabId) => tabs.get(tabId);
export const has = (tabId) => tabs.has(tabId);
export const capturing = (tabId) => making.has(tabId);
export const peers = () => [...conns.keys()];
export const onTabStopped = (fn) => { stopped.push(fn); };

// Card fields covered in what leaves the host's screen (daemon/covers.mjs): the helper sends each
// captured tab's covers ([x, y, w, h] fractions of the tab's view) as they change; joiners' pictures
// (coveredTrack below) and recordings (record.js) draw them as solid boxes. A tab with none known
// yet is covered whole (coversOrWhole).
export const COVER_COLOR = "#293B50"; // ui/tokens.css --edge
export const COVERS_MAX = 200; // per tab
const covers = new Map(); // String(tabId) -> rects
const fraction = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
// The rects of one tab, checked: an array of at most COVERS_MAX [x, y, w, h], each 0..1; null otherwise.
export function rectsIn(v) {
  if (!Array.isArray(v) || v.length > COVERS_MAX) return null;
  for (const r of v) if (!Array.isArray(r) || r.length !== 4 || !r.every(fraction)) return null;
  return v.map((r) => r.slice());
}
// { [tabId]: rects } checked: a Map(String(tabId) -> rects), null when anything in it is off.
export function coversIn(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return null;
  const keys = Object.keys(v);
  if (keys.length > 64) return null;
  const out = new Map();
  for (const k of keys) {
    if (!k || k.length > 128) return null;
    const r = rectsIn(v[k]);
    if (!r) return null;
    out.set(k, r);
  }
  return out;
}
// New covers for tabs: a tab whose covers changed sends its picture again with them.
export function setCovers(map) {
  for (const [k, r] of map) {
    const was = covers.get(k);
    covers.set(k, r);
    if (was && JSON.stringify(was) === JSON.stringify(r)) continue; // unknown before: covered whole, so sent again
    for (const [id, t] of tabs) if (String(id) === k) t.covered?.refresh();
  }
}
export const coversOf = (tabId) => covers.get(String(tabId)) || null;
// Fail closed: a tab whose covers the helper hasn't sent yet (or that never answered) is covered
// whole in recordings and joiners' pictures, until they come.
export const WHOLE_VIEW = Object.freeze([Object.freeze([0, 0, 1, 1])]);
export const coversOrWhole = (tabId) => coversOf(tabId) || WHOLE_VIEW;
// Joiners' direct pictures need frames processed (coveredTrack): without that nothing is sent
// (the joiner's side goes to the slower route, covered in the helper), never the raw picture.
export const NO_COVER = "this browser can't cover card fields in a tab's picture, so none is sent directly";
export const canCover = () => typeof MediaStreamTrackProcessor === "function" && typeof OffscreenCanvas === "function" && typeof VideoFrame === "function" && typeof MediaStreamTrackGenerator === "function";
// The rects drawn over a picture drawn at (x, y) w x h on ctx, rounded outward.
export function paintCovers(ctx, rects, x, y, w, h) {
  if (!rects?.length) return;
  ctx.fillStyle = COVER_COLOR;
  for (const [a, b, c, d] of rects) {
    const X = Math.floor(x + a * w), Y = Math.floor(y + b * h);
    ctx.fillRect(X, Y, Math.ceil(x + (a + c) * w) - X, Math.ceil(y + (b + d) * h) - Y);
  }
}

// What joiners get of a tab's picture: the tab's frames with its covers drawn on (a frame with
// none passes as it is), one per tab for every peer. Made with the capture, so it has the tab's
// first picture (a tab that doesn't change sends no other); the newest picture is sent again
// when the tab's covers change (a still page must not keep a picture covered too late), and once
// a second while peers watch a still tab (the tab's own track answers the encoder's asks for a
// fresh picture itself; this one can't hear them, so a joiner who connects later still gets one).
// null where the browser can't process frames (canCover): joiners then get nothing directly,
// never the tab's own track.
function coveredTrack(tabId, t) {
  if (t.covered) return t.covered.track;
  const source = t.stream.getVideoTracks()[0];
  if (!source || !canCover()) return null;
  const input = source.clone();
  const reader = new MediaStreamTrackProcessor({ track: input }).readable.getReader();
  const oc = new OffscreenCanvas(2, 2);
  const g = oc.getContext("2d", { alpha: false });
  const out = new MediaStreamTrackGenerator({ kind: "video" });
  const writer = out.writable.getWriter();
  let ended = false, last = null, chain = Promise.resolve(), sentAt = 0;
  // The newest picture, covered, out (one at a time, in order).
  const emit = () => {
    chain = chain.then(async () => {
      if (ended || !last) return;
      const rects = coversOrWhole(tabId);
      const w = last.displayWidth, h = last.displayHeight;
      const timestamp = Math.round(performance.now() * 1000);
      sentAt = Date.now();
      if (!rects.length) return writer.write(new VideoFrame(last, { timestamp }));
      if (oc.width !== w || oc.height !== h) { oc.width = w; oc.height = h; }
      g.drawImage(last, 0, 0, w, h);
      paintCovers(g, rects, 0, 0, w, h);
      return writer.write(new VideoFrame(oc, { timestamp }));
    }).catch(() => {});
    return chain;
  };
  const still = setInterval(() => { if (t.peers.size && Date.now() - sentAt > 900) emit(); }, 1000);
  const stop = () => { ended = true; clearInterval(still); reader.cancel().catch(() => {}); input.stop(); out.stop(); last?.close(); last = null; };
  t.covered = { track: out, refresh: emit, stop };
  (async () => {
    while (!ended) {
      const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      if (ended) { frame.close(); break; }
      last?.close();
      last = frame;
      await emit();
      if (out.readyState === "ended") break;
    }
  })();
  return out;
}

const gathered = (pc, ms) => new Promise((resolve) => {
  if (pc.iceGatheringState === "complete") return resolve();
  const done = () => { if (pc.iceGatheringState === "complete") resolve(); };
  pc.addEventListener("icegatheringstatechange", done);
  setTimeout(resolve, ms); // a slow STUN server: go with the candidates found so far
});

// The tab's picture at frame.w x frame.h (the tab's own shape, so nothing is cropped or
// letterboxed), and its sound, which tab capture takes away from the host's speakers: it's
// played here again. One capture per tab, however many ask at once (two joiners, a join and a
// recording): an ask while one is being made waits for it, so no second stream or sound is left over.
export function capture(tabId, streamId, frame) {
  if (tabs.has(tabId)) return Promise.resolve(tabs.get(tabId));
  if (!making.has(tabId)) making.set(tabId, make(tabId, streamId, frame).finally(() => making.delete(tabId)));
  return making.get(tabId);
}

async function make(tabId, streamId, frame) {
  const size = { minWidth: frame.w, maxWidth: frame.w, minHeight: frame.h, maxHeight: frame.h };
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, ...size, maxFrameRate: 30 } },
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  });
  let audio = null;
  if (stream.getAudioTracks().length) {
    audio = new AudioContext();
    audio.createMediaStreamSource(stream).connect(audio.destination);
  }
  const t = { stream, audio, frame, peers: new Set() };
  tabs.set(tabId, t);
  coveredTrack(tabId, t); // joiners' covered picture, from the tab's first frame on
  stream.getVideoTracks()[0]?.addEventListener("ended", () => stopTab(tabId));
  return t;
}

export function stopTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  tabs.delete(tabId);
  covers.delete(String(tabId));
  t.covered?.stop();
  for (const fn of stopped) { try { fn(tabId); } catch {} }
  for (const peer of t.peers) stopPeer(peer);
  for (const track of t.stream.getTracks()) track.stop();
  t.audio?.close().catch(() => {});
}

export function stopPeer(peer) {
  const p = conns.get(peer);
  if (!p) return;
  conns.delete(peer);
  try { p.pc.close(); } catch {}
  const t = tabs.get(p.tabId);
  if (t) { t.peers.delete(peer); if (!t.peers.size && !t.rec) stopTab(p.tabId); } // a recording may still use it
}

export async function offer({ peer, tabId, streamId, frame, ice }) {
  stopPeer(peer);
  let t = tabs.get(tabId);
  if (!t) {
    if (!streamId && !making.has(tabId)) return { error: "no capture for that tab" };
    t = await capture(tabId, streamId, frame);
    if (tabs.get(tabId) !== t) return { error: "the tab's capture ended" };
  }
  // Card fields covered or no picture at all: without frame processing, no direct connection.
  if (t.stream.getVideoTracks().length && !coveredTrack(tabId, t)) {
    if (!t.peers.size && !t.rec) stopTab(tabId);
    return { error: NO_COVER, code: "NO_COVER" };
  }
  const pc = new RTCPeerConnection({ iceServers: Array.isArray(ice) ? ice : [] });
  conns.set(peer, { pc, tabId });
  t.peers.add(peer);
  for (const raw of t.stream.getTracks()) {
    const track = raw.kind === "video" ? coveredTrack(tabId, t) : raw; // card fields covered
    if (!track) continue;
    const sender = pc.addTrack(track, t.stream);
    if (track.kind === "video") {
      const params = sender.getParameters();
      params.degradationPreference = "maintain-framerate"; // smooth first; sharpness follows as bandwidth allows
      params.encodings = [{ ...(params.encodings?.[0] || {}), maxBitrate: 8_000_000, maxFramerate: 30 }];
      sender.setParameters(params).catch(() => {});
    }
  }
  // What the joiner does: ordered, so a press never overtakes the move before it.
  const dc = pc.createDataChannel("input", { ordered: true });
  dc.onmessage = (e) => {
    if (typeof e.data !== "string" || e.data.length > 20_000) return;
    try { tell({ peer, ev: JSON.parse(e.data) }); } catch {}
  };
  pc.onconnectionstatechange = () => {
    tell({ peer, state: pc.connectionState });
    // A still tab's picture at once (and again while the joiner's side gets ready to show it).
    if (pc.connectionState === "connected") for (const ms of [0, 150, 400, 800]) setTimeout(() => t.covered?.refresh?.(), ms);
    if (pc.connectionState === "failed" || pc.connectionState === "closed") stopPeer(peer);
  };
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc, 2500);
  return { sdp: pc.localDescription.sdp };
}

export async function answer({ peer, sdp }) {
  const p = conns.get(peer);
  if (!p) return { error: "no such peer" };
  await p.pc.setRemoteDescription({ type: "answer", sdp: String(sdp) });
  return true;
}

// The host's window changed shape: the picture follows.
export async function resize({ tabId, frame }) {
  const t = tabs.get(tabId);
  if (!t || (t.frame.w === frame.w && t.frame.h === frame.h)) return true;
  t.frame = frame;
  await t.stream.getVideoTracks()[0]?.applyConstraints({ width: frame.w, height: frame.h }).catch(() => {});
  return true;
}

// What joiners did, up to 200 items; max: their size as JSON at most (the helper's reply limit,
// transport-native.js), at least one item. The rest wait for the next take.
export async function take({ ms = 1000, max = Infinity } = {}) {
  if (!inbox.length) await new Promise((r) => { wake = r; setTimeout(r, ms); });
  let n = 0, size = 2; // "[]"
  while (n < inbox.length && n < 200) {
    const s = JSON.stringify(inbox[n]).length + 1;
    if (n && size + s > max) break;
    size += s;
    n++;
  }
  return inbox.splice(0, n);
}
