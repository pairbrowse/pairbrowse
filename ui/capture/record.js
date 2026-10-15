// Recording the browser (pairbrowse_record, the side panel's Record button): what the person
// sees, as a video. The tab in front is captured the way a shared tab is (capture.js), drawn onto a canvas under a strip naming the window's tabs and the agent at work in
// each, and encoded here by the browser. When the person (or an agent) switches tabs, the video
// switches with them. The helper takes the finished file over the browser's private pipe and
// saves it; nothing here talks to a page or the network. Asked only by the helper, through a
// transport (transport-extension.js or transport-native.js): record(m) takes today's rec* ops.
import { captured, has, capture, stopTab, onTabStopped } from "./capture.js";

const STRIP = 40; // the tab strip's height, in CSS pixels
const RECORD_TYPES = ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
const RECORD_MAX_MS = 60 * 60_000; // past an hour the helper saves the recording and stops
const RECORD_MAX_WIDTH = 2560;
const RECORD_BITRATE = 8_000_000;
const FIRST_FRAME_MS = 1500; // a start waits this long at most for the tab's first picture
const STOPPED_EARLY = "the recording was stopped before it began";
let rec = null; // { canvas, ctx, w, h, scale, type, recorder, chunks, front, seq, tabs, labels, started, mine, ready, blob }
const latest = new Map(); // tabId -> the newest picture of each captured tab (a VideoFrame)
const readers = new Map(); // tabId -> { reader, track }
const pending = new Map(); // tabId -> its capture being made (one per tab, however often asked)
const waiting = new Set(); // { tabId, done } for a tab's first picture

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Reads a captured tab's pictures as they come (a tab that doesn't change sends none), keeping
// the newest, so switching to it shows it at once.
function follow(tabId) {
  if (readers.has(tabId)) return;
  const source = captured(tabId)?.stream.getVideoTracks()[0];
  if (!source) return;
  const track = source.clone(); // its own copy: ending it never ends what joiners see
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  readers.set(tabId, { reader, track });
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      latest.get(tabId)?.close();
      latest.set(tabId, value);
      seen(tabId);
      if (rec && !rec.blob && rec.front === tabId) draw();
    }
  })();
}

// The tab's first picture came (or its capture ended): whoever waits for it goes on.
function seen(tabId) {
  for (const w of waiting) if (w.tabId === tabId) { waiting.delete(w); w.done(); }
}
// Resolves once the tab has a picture, or after ms (a tab that doesn't change may send none).
function firstFrame(tabId, ms) {
  if (latest.has(tabId) || !readers.has(tabId)) return Promise.resolve();
  return new Promise((done) => {
    const w = { tabId, done: () => { clearTimeout(timer); done(); } };
    const timer = setTimeout(() => { waiting.delete(w); done(); }, ms);
    waiting.add(w);
  });
}

// A tab's capture ended (capture.js stopTab): its reader and picture go.
function forgetRecorded(tabId) {
  const r = readers.get(tabId);
  if (r) { readers.delete(tabId); r.reader.cancel().catch(() => {}); r.track.stop(); }
  latest.get(tabId)?.close();
  latest.delete(tabId);
  seen(tabId);
}

// A recording that is over, or never began: the captures only it needed end (tabs joiners still
// watch stay), and its canvas stops sending pictures.
function release(r) {
  for (const id of r.mine) {
    const t = captured(id);
    if (!t || (rec && rec !== r && rec.mine.has(id))) continue; // a newer recording uses it
    t.rec = false;
    if (!t.peers.size) stopTab(id);
  }
  r.mine.clear();
  for (const track of r.recorder.stream.getTracks()) track.stop();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}

// The strip: the window's tabs in order, the one in front lit, and on each tab the agent at work
// there in its spark color. Colors from tokens.css (a canvas takes no variables), kept equal by
// test/tokens.test.mjs.
function strip() {
  const { ctx, w, scale } = rec;
  const h = STRIP * scale;
  ctx.fillStyle = "#101D2D";
  ctx.fillRect(0, 0, w, h);
  const list = rec.tabs.length ? rec.tabs : [{ id: rec.front, title: "", active: true }];
  const pad = 8 * scale;
  const tw = Math.min(260 * scale, (w - pad * 2) / list.length);
  ctx.textBaseline = "middle";
  list.forEach((t, i) => {
    const x = pad + i * tw;
    const front = t.id === rec.front;
    if (front) {
      ctx.fillStyle = "#192A3D";
      roundRect(ctx, x + 2 * scale, 6 * scale, tw - 4 * scale, h - 6 * scale, 8 * scale);
      ctx.fill();
    }
    let tx = x + 12 * scale;
    const label = rec.labels[t.id];
    const room = x + tw - 12 * scale;
    if (label?.who) {
      ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(label.color || "") ? label.color : "#e9763f";
      ctx.beginPath();
      ctx.arc(tx + 4 * scale, h / 2 + 3 * scale, 4.5 * scale, 0, Math.PI * 2);
      ctx.fill();
      tx += 14 * scale;
      ctx.font = `600 ${12 * scale}px system-ui, sans-serif`;
      const who = fit(ctx, label.who, Math.max(0, Math.min(room - tx, tw * 0.55)));
      ctx.fillText(who, tx, h / 2 + 3 * scale);
      tx += ctx.measureText(who).width + 8 * scale;
    }
    ctx.font = `${12 * scale}px system-ui, sans-serif`;
    ctx.fillStyle = front ? "#F1F5FA" : "#A2B2C6";
    // The page title without the agent's name in front (daemon/tablabels.mjs): it's named already.
    const title = String(t.title || "New tab");
    const own = label?.prefix && title.startsWith(label.prefix) ? title.slice(label.prefix.length) : title;
    if (room > tx) ctx.fillText(fit(ctx, own, room - tx), tx, h / 2 + 3 * scale);
  });
}

// One picture of the video: the strip, and the tab in front as large as fits below it.
function draw() {
  const { ctx, w, h, scale } = rec;
  const top = STRIP * scale;
  const f = latest.get(rec.front);
  if (f) {
    const fw = f.displayWidth, fh = f.displayHeight;
    const s = Math.min(w / fw, (h - top) / fh);
    const dw = Math.round(fw * s), dh = Math.round(fh * s);
    ctx.fillStyle = "#000";
    if (dw < w || dh < h - top) ctx.fillRect(0, top, w, h - top);
    ctx.drawImage(f, Math.round((w - dw) / 2), top + Math.round((h - top - dh) / 2), dw, dh);
  }
  strip();
}

async function recordStart(m) {
  if (rec && !rec.blob) return { error: "already recording" };
  rec = null; // a finished recording the helper never took (it restarted)
  const type = RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return { error: "this browser can't record video" };
  const frame = m.frame || { w: 1280, h: 800 };
  const scale = Math.max(1, Math.min(2, Number(m.scale) || 1, RECORD_MAX_WIDTH / frame.w));
  const w = even(frame.w * scale), h = even((frame.h + STRIP) * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  // A new picture of the video each time the canvas changes (up to 60 a second): smooth while
  // something moves, nothing while all is still.
  const recorder = new MediaRecorder(canvas.captureStream(60), { mimeType: type, videoBitsPerSecond: RECORD_BITRATE });
  let began;
  const ready = new Promise((done) => { began = done; });
  rec = { canvas, ctx, w, h, scale, type, recorder, chunks: [], front: null, seq: 0, tabs: Array.isArray(m.tabs) ? m.tabs : [], labels: m.labels || {}, started: Date.now(), mine: new Set(), ready, blob: null };
  const mine = rec;
  recorder.ondataavailable = (e) => { if (e.data.size) mine.chunks.push(e.data); };
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  // The recorder starts once the tab in front is captured and its first picture came (capturing
  // takes a moment): started first, the video opened on seconds of black. A capture that fails
  // (the tab closed under it) ends the start, never a recording left running; so does a stop or
  // a clear that came meanwhile (recordStop waits for `ready`).
  try {
    const r = await recordFront(m).catch((e) => ({ error: String(e?.message || e) }));
    if (r?.error) return fail(rec !== mine ? STOPPED_EARLY : r.error);
    if (mine.front != null) await firstFrame(mine.front, FIRST_FRAME_MS);
    if (rec !== mine || mine.blob) return fail(STOPPED_EARLY);
    mine.started = Date.now();
    recorder.start(1000);
    draw(); // the first picture, even of a tab that doesn't change
    return { type: type.split(";")[0], w, h };
  } catch (e) {
    return fail(String(e?.message || e));
  } finally {
    began();
  }
  function fail(error) {
    release(mine);
    if (rec === mine) rec = null;
    return { error };
  }
}

// The tab in front changed: capture it (once) and show it. Asks that overlap (tab switches while
// a capture is made) end with the last one asked in front.
async function recordFront({ tabId, streamId, frame, tabs: list }) {
  const r = rec;
  if (!r || r.blob) return { error: "not recording" };
  if (Array.isArray(list)) r.tabs = list;
  const n = ++r.seq;
  if (!has(tabId)) {
    if (!pending.has(tabId)) {
      if (!streamId) return { need: true };
      const f = frame || { w: r.w / r.scale, h: r.h / r.scale - STRIP };
      pending.set(tabId, capture(tabId, streamId, { w: even(f.w * r.scale), h: even(f.h * r.scale) }).finally(() => pending.delete(tabId)));
    }
    await pending.get(tabId);
  }
  const t = captured(tabId);
  if (!t) return { error: "the tab's capture ended" };
  if (rec !== r || r.blob) { // the recording ended meanwhile: a capture only it wanted ends too
    if (!t.rec && !t.peers.size) stopTab(tabId);
    return { error: "not recording" };
  }
  t.rec = true;
  r.mine.add(tabId);
  follow(tabId);
  if (n === r.seq || r.front == null) r.front = tabId; // a later ask that failed leaves this one
  draw();
  return true;
}

async function recordStop() {
  if (!rec || rec.blob) return { error: "not recording" };
  const r = rec;
  await r.ready; // a stop while the start still waits for the tab: the start ends first
  if (rec !== r || r.blob || r.recorder.state === "inactive") return { error: "not recording" };
  await new Promise((done) => { r.recorder.onstop = done; r.recorder.stop(); });
  r.blob = new Blob(r.chunks, { type: r.type.split(";")[0] });
  r.chunks = [];
  release(r);
  return { size: r.blob.size, type: r.blob.type, ms: Date.now() - r.started };
}

// A piece of the finished file, as base64 (the helper takes it piece by piece).
async function recordChunk({ offset, size }) {
  if (!rec?.blob) return { error: "nothing recorded" };
  const part = rec.blob.slice(Number(offset) || 0, (Number(offset) || 0) + Math.min(Number(size) || 0, 8 * 1024 * 1024));
  const url = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => no(fr.error); fr.readAsDataURL(part); });
  return String(url).slice(String(url).indexOf(",") + 1);
}

export function record(m) {
  if (m.op === "recStart") return recordStart(m);
  if (m.op === "recFront") return recordFront(m);
  if (m.op === "recTabs") {
    if (!rec || rec.blob) return false;
    if (Array.isArray(m.tabs)) rec.tabs = m.tabs;
    if (m.labels && typeof m.labels === "object") rec.labels = m.labels;
    draw();
    return { ms: Date.now() - rec.started, full: Date.now() - rec.started > RECORD_MAX_MS };
  }
  if (m.op === "recStop") return recordStop();
  if (m.op === "recChunk") return recordChunk(m);
  if (m.op === "recClear") {
    // Cleared while recording (the helper restarted on it): nothing keeps running unseen.
    if (rec && !rec.blob && rec.recorder.state !== "inactive") { rec.recorder.onstop = null; rec.recorder.stop(); release(rec); }
    rec = null;
    return true;
  }
  if (m.op === "recState") return rec ? { recording: !rec.blob, ms: Date.now() - rec.started, front: rec.front } : { recording: false };
  return { error: "unknown" };
}

// A capture that ends (capture.js stopTab) takes its reader and picture with it.
onTabStopped(forgetRecorded);
