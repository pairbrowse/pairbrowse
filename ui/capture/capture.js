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
// captured tab's covers ([x, y, w, h] fractions of the tab's view) as it reads them, with their
// mark: this page's clock (coverMark) just before the reads began. Each picture of a tab waits
// (coverGate) until covers read after it came, and goes out drawn with those and the ones in force
// just before it (a field that moved or went away meanwhile stays covered): joiners' pictures
// (coveredTrack below) and recordings (record.js) show only such pictures. No covers read after a
// picture within GATE_MS: that picture goes out covered whole.
export const COVER_COLOR = "#293B50"; // ui/tokens.css --edge
export const COVERS_MAX = 200; // per tab
export const HOLD_MS = 400; // every picture is held this long at least, so they go out evenly
export const GATE_MS = 2000; // a picture whose covers haven't come by then goes out covered whole
const GATE_FRAMES = 15; // pictures waiting per tab, at most (past it, ones in between are dropped)
const LAG_MS = 100; // a picture shows the page as it was a moment before it came
const HISTORY = 40; // reads kept per tab
const history = new Map(); // String(tabId) -> [{ rects, mark }], oldest first (marked reads only)
const gates = new Map(); // String(tabId) -> its gate's pump
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
// This page's clock, for the helper to mark its reads with.
export const coverMark = () => performance.now();
// New covers for tabs, read from mark on (null: not matched to pictures, so not kept). Pictures
// waiting for them go on.
export function setCovers(map, mark = null) {
  const at = typeof mark === "number" && Number.isFinite(mark) && mark <= performance.now() + 1 ? mark : null;
  for (const [k, r] of map) {
    if (at === null) continue; // not matched to pictures (an older helper's, or a navigation's): nothing to match
    const h = history.get(k) || [];
    if (h.length && h[h.length - 1].mark > at) continue; // out of order: never matched backwards
    h.push({ rects: r, mark: at });
    if (h.length > HISTORY) h.splice(0, h.length - HISTORY);
    history.set(k, h);
  }
  for (const k of map.keys()) gates.get(k)?.();
}
export const WHOLE_VIEW = Object.freeze([Object.freeze([0, 0, 1, 1])]);
// The covers for a picture of the tab that came at t (this page's clock): the first read that
// began at or after t, joined with those in force LAG_MS before it; null until such a read came.
export function rectsAt(tabId, t) {
  const h = history.get(String(tabId)) || [];
  const i = h.findIndex((e) => e.mark >= t);
  if (i < 0) return null;
  let from = i;
  while (from > 0 && h[from - 1].mark > t - LAG_MS) from--;
  if (from > 0) from--;
  const seen = new Map();
  for (let k = from; k <= i; k++) for (const r of h[k].rects) seen.set(r.join(","), r);
  return seen.size > COVERS_MAX ? WHOLE_VIEW : [...seen.values()];
}
// Joiners' direct pictures and recordings need frames processed (coverGate): without that no
// picture is sent directly (the joiner's side goes to the slower route, covered in the helper).
export const NO_COVER = "this browser can't cover card fields in a tab's picture, so none is sent directly";
export const canCover = () => typeof MediaStreamTrackProcessor === "function" && typeof OffscreenCanvas === "function" && typeof VideoFrame === "function" && typeof MediaStreamTrackGenerator === "function" && typeof createImageBitmap === "function";
// The rects drawn over a picture drawn at (x, y) w x h on ctx, rounded outward.
export function paintCovers(ctx, rects, x, y, w, h) {
  if (!rects?.length) return;
  ctx.fillStyle = COVER_COLOR;
  for (const [a, b, c, d] of rects) {
    const X = Math.floor(x + a * w), Y = Math.floor(y + b * h);
    ctx.fillRect(X, Y, Math.ceil(x + (a + c) * w) - X, Math.ceil(y + (b + d) * h) - Y);
  }
}

// A tab's pictures, each let out once its covers are known (rectsAt) and HOLD_MS after it came,
// or GATE_MS after it came covered whole, in order: t.shown is the latest let out ({ bmp, t,
// rects, whole }: an ImageBitmap this gate owns until the next) and each of t.subs hears of it.
// A picture let out whole goes out again once its covers come (a still tab keeps no picture
// covered longer than needed). Made with the capture; null where frames can't be processed.
function coverGate(tabId, t) {
  const source = t.stream.getVideoTracks()[0];
  if (!source || !canCover()) return null;
  const k = String(tabId);
  const input = source.clone(); // its own copy: stopping it never ends the tab's capture
  const reader = new MediaStreamTrackProcessor({ track: input }).readable.getReader();
  const queue = []; // { bmp, t }
  let ended = false, timer = null;
  const show = (s) => {
    const was = t.shown;
    t.shown = s;
    if (was && was.bmp !== s.bmp) was.bmp.close();
    for (const fn of t.subs) { try { fn(s); } catch {} }
  };
  const pump = () => {
    clearTimeout(timer);
    timer = null;
    if (ended) return;
    const now = performance.now();
    while (queue.length) {
      const q = queue[0];
      if (now < q.t + HOLD_MS) break;
      let rects = rectsAt(k, q.t), whole = false;
      if (!rects) {
        if (now < q.t + GATE_MS) break;
        rects = WHOLE_VIEW;
        whole = true;
      }
      queue.shift();
      show({ bmp: q.bmp, t: q.t, rects, whole });
    }
    if (!queue.length && t.shown?.whole) {
      const rects = rectsAt(k, t.shown.t);
      if (rects) show({ ...t.shown, rects, whole: false });
    }
    if (queue.length) {
      const q = queue[0];
      const due = rectsAt(k, q.t) ? q.t + HOLD_MS : q.t + GATE_MS;
      timer = setTimeout(pump, Math.max(5, due - now));
    }
  };
  gates.set(k, pump);
  (async () => {
    while (!ended) {
      const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      const at = performance.now();
      if (ended) { frame.close(); break; }
      const bmp = await createImageBitmap(frame).catch(() => null);
      frame.close();
      if (!bmp) continue;
      if (ended) { bmp.close(); break; }
      queue.push({ bmp, t: at });
      // Too many waiting: drop the one after the oldest (the oldest keeps its age, so a tab whose
      // covers don't come still goes out covered whole in time).
      while (queue.length > GATE_FRAMES) queue.splice(1, 1)[0].bmp.close();
      pump();
    }
  })();
  return {
    stop() {
      ended = true;
      clearTimeout(timer);
      if (gates.get(k) === pump) gates.delete(k);
      reader.cancel().catch(() => {});
      input.stop();
      for (const q of queue.splice(0)) q.bmp.close();
      t.shown?.bmp.close();
      t.shown = null;
    },
  };
}

// What joiners get of a tab's picture: its pictures as the gate lets them out, covers drawn on (a
// picture with none passes as it is), one track per tab for every peer. The newest picture goes
// out again once a second while peers watch a still tab (the tab's own track answers the
// encoder's asks for a fresh picture itself; this one can't hear them, so a joiner who connects
// later still gets one). null where the browser can't process frames (canCover): joiners then get
// nothing directly, never the tab's own track.
function coveredTrack(tabId, t) {
  if (t.covered) return t.covered.track;
  if (!t.gate) return null;
  const oc = new OffscreenCanvas(2, 2);
  const g = oc.getContext("2d", { alpha: false });
  const out = new MediaStreamTrackGenerator({ kind: "video" });
  const writer = out.writable.getWriter();
  let ended = false, chain = Promise.resolve(), sentAt = 0, lastTs = 0, lastAt = 0, shift = 0, last = null;
  // The newest picture, covered, out (one at a time, in order). Its time is when it came (plus a
  // shift that only grows), so pictures held together still play evenly; the same picture again
  // goes out as many microseconds after the last as have passed since. Always increasing.
  const emit = () => {
    chain = chain.then(async () => {
      const s = t.shown;
      if (ended || !s) return;
      const again = last === s.bmp;
      last = s.bmp;
      let timestamp;
      if (again) timestamp = lastTs + Math.max(1, Math.round((performance.now() - lastAt) * 1000));
      else {
        timestamp = Math.round(s.t * 1000) + shift;
        if (timestamp <= lastTs) { shift += lastTs + 1 - timestamp; timestamp = lastTs + 1; }
      }
      lastTs = timestamp;
      lastAt = performance.now();
      sentAt = Date.now();
      const w = s.bmp.width, h = s.bmp.height;
      if (oc.width !== w || oc.height !== h) { oc.width = w; oc.height = h; }
      g.drawImage(s.bmp, 0, 0, w, h);
      paintCovers(g, s.rects, 0, 0, w, h);
      return writer.write(new VideoFrame(oc, { timestamp }));
    }).catch(() => {});
    return chain;
  };
  const still = setInterval(() => { if (t.peers.size && Date.now() - sentAt > 900) emit(); }, 1000);
  t.subs.add(emit);
  const stop = () => { ended = true; clearInterval(still); t.subs.delete(emit); out.stop(); };
  t.covered = { track: out, refresh: emit, stop };
  emit(); // a picture let out before this track was made
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
  const t = { stream, audio, frame, peers: new Set(), shown: null, subs: new Set() };
  tabs.set(tabId, t);
  t.gate = coverGate(tabId, t); // pictures with their covers, from the tab's first frame on
  coveredTrack(tabId, t); // joiners' covered picture
  stream.getVideoTracks()[0]?.addEventListener("ended", () => stopTab(tabId));
  return t;
}

export function stopTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  tabs.delete(tabId);
  history.delete(String(tabId));
  t.covered?.stop();
  t.gate?.stop();
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
