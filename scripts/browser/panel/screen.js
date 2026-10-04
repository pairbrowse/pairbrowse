// Shared browser mode, on the joiner's side: one of these pages stands in for each of the host's
// tabs. It shows the host's tab live (WebRTC, peer to peer: share.js on the host) and sends what
// you do (pointer, wheel, keys, pasted text) back over the same connection, so you work in the
// host's own browser, logged in as they are. When no direct connection can be made, pictures
// come through the helper instead (frame()) and so does input (takeInput()). Driven only by this
// PairBrowse's helper, through window.pbScreen.
const ICE = [{ urls: "stun:stun.cloudflare.com:3478" }];
const MOD = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const $ = (id) => document.getElementById(id);
const video = $("v"), still = $("still"), statusBox = $("status"), statusText = $("status-text"), tag = $("tag"), tagText = $("tag-text"), soundButton = $("sound");

let pc = null, dc = null, peer = "", host = "", view = "video"; // view: "video" or "frames"
const outbox = []; // input for the helper, while there's no direct connection
let state = "none";

function setStatus(text) {
  if (text) { statusText.textContent = text; statusBox.classList.remove("hidden"); } else statusBox.classList.add("hidden");
}
function showLive(on) {
  tag.classList.toggle("on", on);
  setStatus(on ? "" : statusText.textContent);
}

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
    document.title = String(title || url || "Shared tab").slice(0, 200);
    tagText.textContent = host ? `${host}'s tab · live` : "Shared tab · live";
    if (state === "none" && view === "video") setStatus(`Connecting to ${host || "the host"}'s tab…`);
  },
  // What the helper needs to know each round, and the input waiting for it (no direct connection).
  state: () => ({ visible: document.visibilityState === "visible", conn: state, peer, view, direct: !!(dc && dc.readyState === "open") }),
  takeInput: () => outbox.splice(0, 200),
};
