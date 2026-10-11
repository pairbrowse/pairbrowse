// Shared browser mode, on the host: the extension's offscreen document. It captures a shared tab
// (picture and sound, tabCapture) and sends it straight to each joiner's PairBrowse over WebRTC,
// peer to peer: the tunnel only carries the few messages that set the connection up. What the
// joiner does (pointer, keys) comes back on the same connection and waits here until the helper
// takes it (it alone decides what to replay, and where). Asked only by the helper, through the
// extension's worker (background.js).
const tabs = new Map(); // tabId -> { stream, audio, frame: { w, h }, peers: Set, rec: recording uses it }
const peers = new Map(); // peer -> { pc, tabId }
const inbox = []; // { peer, ev } or { peer, state }, until the helper takes them
let wake = null;
const tell = (item) => {
  if (inbox.length > 2000) inbox.splice(0, inbox.length - 1000); // nobody is taking them
  inbox.push(item);
  if (wake) { wake(); wake = null; }
};

const gathered = (pc, ms) => new Promise((resolve) => {
  if (pc.iceGatheringState === "complete") return resolve();
  const done = () => { if (pc.iceGatheringState === "complete") resolve(); };
  pc.addEventListener("icegatheringstatechange", done);
  setTimeout(resolve, ms); // a slow STUN server: go with the candidates found so far
});

// The tab's picture at frame.w x frame.h (the tab's own shape, so nothing is cropped or
// letterboxed), and its sound, which tab capture takes away from the host's speakers: it's
// played here again.
async function capture(tabId, streamId, frame) {
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

function stopTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  tabs.delete(tabId);
  globalThis.forgetRecorded?.(tabId); // record.js
  for (const peer of t.peers) stopPeer(peer);
  for (const track of t.stream.getTracks()) track.stop();
  t.audio?.close().catch(() => {});
}

function stopPeer(peer) {
  const p = peers.get(peer);
  if (!p) return;
  peers.delete(peer);
  try { p.pc.close(); } catch {}
  const t = tabs.get(p.tabId);
  if (t) { t.peers.delete(peer); if (!t.peers.size && !t.rec) stopTab(p.tabId); } // a recording may still use it
}

async function offer({ peer, tabId, streamId, frame, ice }) {
  stopPeer(peer);
  let t = tabs.get(tabId);
  if (!t) {
    if (!streamId) return { error: "no capture for that tab" };
    t = await capture(tabId, streamId, frame);
  }
  const pc = new RTCPeerConnection({ iceServers: Array.isArray(ice) ? ice : [] });
  peers.set(peer, { pc, tabId });
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

// The host's window changed shape: the picture follows.
async function resize({ tabId, frame }) {
  const t = tabs.get(tabId);
  if (!t || (t.frame.w === frame.w && t.frame.h === frame.h)) return true;
  t.frame = frame;
  await t.stream.getVideoTracks()[0]?.applyConstraints({ width: frame.w, height: frame.h }).catch(() => {});
  return true;
}

async function take({ ms = 1000 } = {}) {
  if (!inbox.length) await new Promise((r) => { wake = r; setTimeout(r, ms); });
  return inbox.splice(0, 200);
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.to !== "share") return;
  (async () => {
    if (m.op === "has") return tabs.has(m.tabId);
    if (m.op === "offer") return offer(m);
    if (m.op === "answer") { const p = peers.get(m.peer); if (!p) return { error: "no such peer" }; await p.pc.setRemoteDescription({ type: "answer", sdp: String(m.sdp) }); return true; }
    if (m.op === "stop") { stopPeer(m.peer); return true; }
    if (m.op === "stopTab") { stopTab(m.tabId); return true; }
    if (m.op === "resize") return resize(m);
    if (m.op === "take") return take(m);
    if (m.op === "peers") return [...peers.keys()];
    if (String(m.op).startsWith("rec")) return globalThis.record(m); // record.js
    return { error: "unknown" };
  })().then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});
