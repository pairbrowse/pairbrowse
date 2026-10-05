// Shared browser mode, on the joiner's side: one of these pages stands in for each of the host's
// tabs. It shows the host's tab live (WebRTC, peer to peer: share.js on the host) and sends what
// you do (pointer, wheel, keys, pasted text) back over the same connection, so you work in the
// host's own browser, logged in as they are. When no direct connection can be made, pictures
// come through the helper instead (frame()) and so does input (takeInput()). Driven only by this
// PairBrowse's helper, through window.pbScreen.
const ICE = [{ urls: "stun:stun.cloudflare.com:3478" }];
const MOD = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const $ = (id) => document.getElementById(id);
const video = $("v"), still = $("still"), statusBox = $("status"), statusText = $("status-text"), bar = $("top"), tagText = $("tag-text"), soundButton = $("sound");

let pc = null, dc = null, peer = "", host = "", view = "video"; // view: "video" or "frames"
const outbox = []; // input for the helper, while there's no direct connection
let state = "none";

function setStatus(text) {
  if (text) { statusText.textContent = text; statusBox.classList.remove("hidden"); } else statusBox.classList.add("hidden");
}
let tagTimer = null;
function showLive(on) {
  // Says whose tab it is and where it is, then gets out of the way (it comes back when the
  // pointer goes near it, and when the host's tab goes somewhere else).
  bar.classList.toggle("on", on);
  clearTimeout(tagTimer);
  if (on) tagTimer = setTimeout(() => bar.classList.remove("on"), 4000);
  setStatus(on ? "" : statusText.textContent);
}
const live = () => state === "connected" || view === "frames";

// ---- the host tab's real address, as a browser's address bar shows it ----
// This page's own address can't be the host's (an extension page), and the site is never loaded
// here (that would be you, with your cookies, on their page). So the address shows on the
// picture: the site in full, the rest dimmed, a lock for a secure page.
const LOCK = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 1a2.6 2.6 0 0 0-2.6 2.6V5H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-.4V3.6A2.6 2.6 0 0 0 6 1Zm-1.4 4V3.6a1.4 1.4 0 0 1 2.8 0V5Z"/></svg>';
const INFO = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="6" cy="6" r="4.6"/><path d="M6 5.4v3M6 3.6v.1" stroke-linecap="round"/></svg>';
const LOCAL = /^(localhost|127(\.\d+){3}|\[::1\])$/;
// { host, rest, secure: true | false | null (no web address) } for a tab address; null: none.
function readAddress(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { host: "", rest: u.href, secure: null };
  const rest = (u.pathname === "/" && !u.search && !u.hash ? "" : u.pathname) + u.search + u.hash;
  return { host: u.host, rest, secure: u.protocol === "https:" ? true : LOCAL.test(u.hostname) ? null : false };
}
let shownAddress = "";
function showAddress(raw) {
  const a = readAddress(raw), box = $("addr"), st = $("addr-state");
  box.hidden = !a;
  if (!a) return false;
  $("addr-host").textContent = a.host;
  $("addr-rest").textContent = a.rest;
  st.className = a.secure === false ? "warn" : "";
  st.innerHTML = a.secure === true ? LOCK : a.secure === false ? `${INFO}<span class="note">Not secure</span>` : a.host ? INFO : "";
  const changed = shownAddress !== "" && shownAddress !== raw;
  shownAddress = String(raw);
  return changed;
}
// A tab without a title is named by its address (without https://), as a browser does.
const titleFor = (title, url) => { const a = readAddress(url); return String(title || (a ? a.host + a.rest : "") || "Shared tab").slice(0, 200); };

// The part of the window the host's tab fills (it keeps its shape, centered).
function shown() {
  const el = view === "frames" ? still : video;
  const fw = view === "frames" ? still.width : video.videoWidth, fh = view === "frames" ? still.height : video.videoHeight;
  if (!fw || !fh) return null;
  const w = innerWidth, h = innerHeight, s = Math.min(w / fw, h / fh);
  return { el, x: (w - fw * s) / 2, y: (h - fh * s) / 2, w: fw * s, h: fh * s };
}
// The page's own controls (the file request, the sound button) take their clicks and keys.
const ours = (e) => !!e.target?.closest?.("#pick, #sound");
const norm = (e) => {
  if (ours(e)) return null;
  const r = shown();
  if (!r) return null;
  const nx = (e.clientX - r.x) / r.w, ny = (e.clientY - r.y) / r.h;
  return nx < 0 || ny < 0 || nx > 1 || ny > 1 ? null : { nx: Math.round(nx * 10000) / 10000, ny: Math.round(ny * 10000) / 10000 };
};

function send(ev) {
  if (dc && dc.readyState === "open") { try { dc.send(JSON.stringify(ev)); return; } catch {} }
  if (outbox.length < 500) outbox.push(ev);
}

// ---- input ----
let moveQueued = null;
const BUTTON = ["left", "middle", "right"];
addEventListener("pointermove", (e) => {
  if (e.clientY < 60 && e.clientX < bar.offsetWidth + 60 && live() && !bar.classList.contains("on")) showLive(true);
  const at = norm(e);
  if (!at) return;
  const first = !moveQueued;
  moveQueued = { t: "mouse", a: "mouseMoved", ...at, b: "none", bs: e.buttons, m: MOD(e) };
  if (first) requestAnimationFrame(() => { if (moveQueued) send(moveQueued); moveQueued = null; });
});
addEventListener("pointerdown", (e) => {
  const at = norm(e);
  if (!at) return;
  if (moveQueued) { send(moveQueued); moveQueued = null; }
  send({ t: "mouse", a: "mousePressed", ...at, b: BUTTON[e.button] || "left", bs: e.buttons, c: Math.max(1, e.detail || 1), m: MOD(e) });
});
addEventListener("pointerup", (e) => {
  const at = norm(e);
  if (!at) return;
  if (moveQueued) { send(moveQueued); moveQueued = null; }
  send({ t: "mouse", a: "mouseReleased", ...at, b: BUTTON[e.button] || "left", bs: e.buttons, c: Math.max(1, e.detail || 1), m: MOD(e) });
});
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("wheel", (e) => {
  const at = norm(e);
  if (!at) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1;
  send({ t: "wheel", ...at, dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k) });
}, { passive: false });
// Keys go to the host's page as they are. Copying and pasting stay with your own clipboard:
// a paste sends its text; the host's clipboard is never used.
const CLIPBOARD = new Set(["c", "x", "v"]);
const KEEP = new Set(["t", "w", "n", "l", "r", "q", "tab"]); // your own browser's shortcuts (new tab, close, address bar...)
function key(e, a) {
  if (!$("pick").hidden || ours(e)) return;
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && (CLIPBOARD.has(k) || KEEP.has(k))) return;
  e.preventDefault();
  send({ t: "key", a, key: e.key.slice(0, 32), code: e.code.slice(0, 32), kc: e.keyCode || 0, loc: e.location || 0, rep: !!e.repeat, m: MOD(e) });
}
addEventListener("keydown", (e) => key(e, "down"));
addEventListener("keyup", (e) => key(e, "up"));
addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text/plain") || "";
  if (text) { e.preventDefault(); send({ t: "text", text: text.slice(0, 2000) }); }
});

// ---- pointers: the host's, and other people's, over the picture ----
const drawn = new Map(); // key -> element
function pointers(list) {
  const r = shown();
  const keep = new Set();
  for (const p of Array.isArray(list) ? list.slice(0, 12) : []) {
    if (!r || typeof p?.nx !== "number" || typeof p?.ny !== "number") continue;
    const k = String(p.k || p.who || "");
    keep.add(k);
    let el = drawn.get(k);
    if (!el) {
      el = document.createElement("div");
      el.className = "p";
      el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2.5l6.8 18.2 2.5-7.4 7.4-2.5z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span></span>';
      $("pointers").appendChild(el);
      drawn.set(k, el);
    }
    const color = /^#[0-9a-f]{6}$/i.test(p.color || "") ? p.color : "#e9763f";
    el.querySelector("path").setAttribute("fill", color);
    const label = el.querySelector("span");
    label.style.background = color;
    label.textContent = String(p.who || "").slice(0, 40);
    el.style.transform = `translate(${Math.round(r.x + p.nx * r.w)}px, ${Math.round(r.y + p.ny * r.h)}px)`;
  }
  for (const [k, el] of drawn) if (!keep.has(k)) { el.remove(); drawn.delete(k); }
}

// ---- who works in the host's tab: their name before the title, their mark as the tab's icon ----
// A person using it by hand: a dot in their color. An agent holding it: the spark in its color
// (with the person's dot in a corner when both are there).
const SPARK = "M8 0.8c.5 0 .8.4.9.9l.5 4 3.3-2.3c.4-.3 1-.2 1.3.2.3.4.2 1-.2 1.3L10.6 7.3l4 .6c.5.1.9.5.8 1-.1.5-.5.8-1 .7l-4-.5 2.3 3.3c.3.4.2 1-.2 1.3-.4.3-1 .2-1.3-.2L8.9 10.2l-.5 4c-.1.5-.5.9-1 .8-.5 0-.8-.5-.8-1l.6-4-3.3 2.3c-.4.3-1 .2-1.3-.2-.3-.4-.2-1 .2-1.3l3.2-2.4-4-.5c-.5-.1-.9-.5-.8-1 .1-.5.5-.8 1-.8l4 .6L3.9 3.5c-.3-.4-.2-1 .2-1.3.4-.3 1-.2 1.3.2l2.4 3.3.5-4c0-.5.4-.9.9-.9Z";
const COLOR = /^#[0-9a-f]{6}$/i;
let baseTitle = "Shared tab";
let inTab = { person: "", personColor: "", agent: "", agentColor: "" };
function dot(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(2, r / 5);
  ctx.strokeStyle = "#fff";
  ctx.stroke();
}
function whoIcon() {
  const agent = inTab.agent && COLOR.test(inTab.agentColor) ? inTab.agentColor : "";
  const person = inTab.person && COLOR.test(inTab.personColor) ? inTab.personColor : "";
  if (!agent && !person) return "";
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (agent) {
    ctx.save();
    ctx.scale(4, 4);
    ctx.fillStyle = agent;
    ctx.fill(new Path2D(SPARK));
    ctx.restore();
    if (person) dot(ctx, 48, 48, 14, person);
  } else dot(ctx, 32, 32, 24, person);
  return c.toDataURL("image/png");
}
function showWho() {
  const names = [inTab.person, inTab.agent ? `\u2726 ${inTab.agent}` : ""].filter(Boolean);
  document.title = (names.length ? `${names.join(" ")} \u00b7 ` : "") + baseTitle;
  let link = document.querySelector('link[rel="icon"]');
  const href = whoIcon();
  if (!href) { link?.remove(); return; }
  if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
  if (link.href !== href) link.href = href;
}

// ---- the connection ----
async function offer({ sdp, peer: id, noDirect = false }) {
  close();
  peer = String(id || "");
  pc = new RTCPeerConnection(noDirect ? { iceServers: [], iceTransportPolicy: "relay" } : { iceServers: ICE });
  state = "connecting";
  setStatus(`Connecting to ${host || "the host"}'s tab…`);
  pc.ontrack = (e) => {
    if (video.srcObject !== e.streams[0]) video.srcObject = e.streams[0];
    video.muted = false;
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); soundButton.hidden = false; });
  };
  pc.ondatachannel = (e) => {
    dc = e.channel;
    dc.onopen = () => { while (outbox.length) { try { dc.send(JSON.stringify(outbox.shift())); } catch { break; } } };
  };
  pc.onconnectionstatechange = () => {
    state = pc.connectionState;
    if (state === "connected") { view = "video"; still.hidden = true; video.hidden = false; showLive(true); }
    else if (state === "disconnected") { showLive(false); setStatus("Reconnecting…"); }
    else if (state === "failed") { showLive(false); setStatus("No direct connection: switching to the slower route…"); }
  };
  await pc.setRemoteDescription({ type: "offer", sdp: String(sdp) });
  await pc.setLocalDescription(await pc.createAnswer());
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve());
    setTimeout(resolve, 2500);
  });
  return pc.localDescription.sdp;
}
function close() {
  try { pc?.close(); } catch {}
  pc = null; dc = null; peer = "";
  state = "none";
}

// Pictures through the helper (no direct connection possible): JPEG frames.
let frameImage = null;
function frame(b64) {
  if (!frameImage) frameImage = new Image();
  frameImage.onload = () => {
    if (still.width !== frameImage.naturalWidth || still.height !== frameImage.naturalHeight) { still.width = frameImage.naturalWidth; still.height = frameImage.naturalHeight; }
    still.getContext("2d").drawImage(frameImage, 0, 0);
    if (view !== "frames") { view = "frames"; still.hidden = false; video.hidden = true; }
    showLive(true);
  };
  frameImage.src = "data:image/jpeg;base64," + b64;
}

soundButton.addEventListener("click", () => { video.muted = false; video.play().catch(() => {}); soundButton.hidden = true; });

// A file field you clicked in the host's tab: you pick the files on your own computer (the host's
// file dialog never opens). Resolves to [{ name, b64 }] (empty: cancelled).
const FILE_MAX = 50 * 1024 * 1024;
function pick({ multiple = false } = {}) {
  const box = $("pick"), input = $("pick-input");
  input.multiple = !!multiple;
  input.value = "";
  $("pick-text").textContent = `${host ? `${host}'s` : "The"} page asks for ${multiple ? "files" : "a file"}. They're sent from your computer.`;
  return new Promise((resolve) => {
    const finish = async (list) => {
      box.hidden = true;
      const out = [];
      for (const f of list.slice(0, 20)) {
        if (f.size > FILE_MAX) continue;
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        out.push({ name: f.name.slice(0, 120), b64: btoa(bin) });
      }
      resolve(out);
    };
    input.onchange = () => finish([...input.files]);
    input.oncancel = () => finish([]);
    $("pick-go").onclick = () => input.click();
    $("pick-no").onclick = () => finish([]);
    box.hidden = false;
    try { input.click(); } catch {} // right away while your click still counts; else the button
  });
}

window.pbScreen = {
  offer,
  pick,
  close,
  frame,
  pointers,
  info({ title, url, who } = {}) {
    host = String(who || host || "").slice(0, 40);
    baseTitle = titleFor(title, url);
    showWho();
    tagText.textContent = host ? `${host}'s tab · live` : "Shared tab · live";
    if (showAddress(url) && live()) showLive(true); // the host's tab went somewhere else: say where
    if (state === "none" && view === "video") setStatus(`Connecting to ${host || "the host"}'s tab…`);
    return true;
  },
  // Who works in the host's tab ({ person, personColor, agent, agentColor }; empty: nobody).
  who(w = {}) {
    inTab = { person: String(w.person || "").slice(0, 40), personColor: String(w.personColor || ""), agent: String(w.agent || "").slice(0, 40), agentColor: String(w.agentColor || "") };
    showWho();
    return true;
  },
  inTab: () => ({ ...inTab, title: document.title, icon: !!document.querySelector('link[rel="icon"]') }),
  // The address shown on the picture (as the person reads it), and whether a lock is there.
  address: () => ({ shown: !$("addr").hidden, text: $("addr-text").textContent, lock: $("addr-state").innerHTML === LOCK, warn: $("addr-state").classList.contains("warn") }),
  // What the helper needs to know each round, and the input waiting for it (no direct connection).
  state: () => ({ visible: document.visibilityState === "visible", conn: state, peer, view, direct: !!(dc && dc.readyState === "open") }),
  takeInput: () => outbox.splice(0, 200),
  // How the picture and sound arrive: frames a second, sound received, whether it plays, and the
  // route (direct between the two computers, or found through STUN).
  async stats() {
    if (!pc) return { conn: state, view };
    const out = { conn: state, view, muted: video.muted, paused: video.paused, fps: 0, frames: 0, audioBytes: 0, videoBytes: 0, route: "" };
    const report = await pc.getStats();
    let pair = null;
    report.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video") { out.fps = s.framesPerSecond || 0; out.frames = s.framesDecoded || 0; out.videoBytes = s.bytesReceived || 0; out.size = [s.frameWidth, s.frameHeight]; }
      if (s.type === "inbound-rtp" && s.kind === "audio") out.audioBytes = s.bytesReceived || 0;
      if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
    });
    if (pair) { const local = report.get(pair.localCandidateId); out.route = local?.candidateType || ""; out.rtt = pair.currentRoundTripTime; }
    return out;
  },
};
