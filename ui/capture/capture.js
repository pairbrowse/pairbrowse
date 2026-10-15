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
  stream.getVideoTracks()[0]?.addEventListener("ended", () => stopTab(tabId));
  return t;
}

export function stopTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  tabs.delete(tabId);
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
  const pc = new RTCPeerConnection({ iceServers: Array.isArray(ice) ? ice : [] });
  conns.set(peer, { pc, tabId });
  t.peers.add(peer);
  for (const track of t.stream.getTracks()) {
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
