// The capture page as the PairBrowse browser's own page (chrome://pairbrowse.top-chrome/capture/,
// one per profile, never shown; plans/550-capture.md D4, D5). The helper asks with a `capture`
// event { n, to: "share" | "record", op, ... } on this page's own event stream
// (events?panel=1&page=capture, never the pages' shared one) and gets its answer on
// POST capture/reply { n, value } or { n, error }; on every open the page says hello with what it
// can do. Tabs are named by their DevTools target id (the helper's tabRef in page mode). What the
// extension's worker does for the offscreen document is done here: a tab's stream id comes from
// the browser (session.grantTabCapture, only for this page and only for ordinary web tabs), and a
// recording follows the tab in front through the browser's Tabs and Windows observers, held only
// while a recording runs. Answers stay inside the helper's limits (liveview/capture.mjs): a value
// up to CAPTURE_VALUE_MAX as JSON, an offer's SDP up to CAPTURE_SDP_MAX, an error up to
// CAPTURE_ERROR_MAX characters; a recording's pieces at most PAGE_CHUNK_BYTES (daemon/recorder.mjs).
// No timer but the 150 ms strip refresh while recording (as the extension's worker has), no poll.
import { has, offer, answer, stopPeer, stopTab, resize, take, peers } from "./capture.js";
import { record } from "./record.js";
import { helperStream } from "../common.js";

export const CAPTURE_VALUE_MAX = 1_500_000;
export const CAPTURE_SDP_MAX = 100_000;
export const CAPTURE_ERROR_MAX = 300;
export const PAGE_CHUNK_BYTES = 1024 * 1024;
const TAKE_ROOM = CAPTURE_VALUE_MAX - 4096; // what joiners did, as JSON, with room to spare
const TAKE_MS_MAX = 10_000;
const FRAME_MAX = 4096;
const ICE_MAX = 16;
const STRIP_WAIT_MS = 150;

const text = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const targetOf = (v) => text(v, 128);
const peerOf = (v) => text(v, 128);
const frameOf = (f) => {
  const ok = (n) => Number.isInteger(n) && n >= 2 && n <= FRAME_MAX;
  return f && typeof f === "object" && ok(f.w) && ok(f.h) ? { w: f.w, h: f.h } : null;
};
const fail = (e) => ({ error: String(e?.message || e || "failed").slice(0, CAPTURE_ERROR_MAX) });

// What this page can do, said in each hello (D4).
export function caps(pb, scope = globalThis) {
  return {
    share: typeof scope.RTCPeerConnection === "function" && typeof pb?.session?.grantTabCapture === "function",
    record: typeof scope.MediaRecorder === "function" && typeof scope.MediaStreamTrackProcessor === "function",
  };
}

// An answer as the helper takes it, or an error that says why not. A refusal the core returns
// ({ error }) stays a value, as the extension answers it (the helper reads r.error), cut to the
// error limit; a call that threw is the reply's own error (call below).
export function bounded(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "error" in value) return { value: { ...value, error: String(value.error ?? "").slice(0, CAPTURE_ERROR_MAX) } };
  if (value && typeof value === "object" && "sdp" in value && (typeof value.sdp !== "string" || value.sdp.length > CAPTURE_SDP_MAX)) return fail("the offer is too large");
  if (typeof value === "string") return value.length <= CAPTURE_VALUE_MAX ? { value } : fail("the answer is too large");
  if (value === undefined) return {};
  let size;
  try { size = JSON.stringify(value).length; } catch { return fail("the answer can't be sent"); }
  return size <= CAPTURE_VALUE_MAX ? { value } : fail("the answer is too large");
}

// The helper's calls, over the browser's API (pb: window.pairbrowse).
export function createNativeCapture(pb) {
  const grant = async (targetId) => {
    const r = await pb.session.grantTabCapture(targetId, true);
    return typeof r?.streamId === "string" && r.streamId ? r.streamId : null;
  };

  async function share(m) {
    switch (m.op) {
      case "has": { const t = targetOf(m.tabId); return !!t && has(t); }
      case "offer": {
        const peer = peerOf(m.peer), tabId = targetOf(m.tabId), frame = frameOf(m.frame);
        if (!peer || !tabId || !frame) return { error: "an offer is { peer, tabId, frame, ice }" };
        const ice = Array.isArray(m.ice) ? m.ice.slice(0, ICE_MAX) : [];
        let streamId;
        if (!has(tabId)) {
          streamId = await grant(tabId);
          if (!streamId) return { error: "the browser didn't let that tab be captured" };
        }
        const r = await offer({ peer, tabId, streamId, frame, ice });
        if (r?.sdp && r.sdp.length > CAPTURE_SDP_MAX) { stopPeer(peer); return { error: "the offer is too large" }; }
        return r;
      }
      case "answer": {
        const peer = peerOf(m.peer);
        if (!peer || typeof m.sdp !== "string" || m.sdp.length > CAPTURE_SDP_MAX) return { error: "an answer is { peer, sdp }" };
        return answer({ peer, sdp: m.sdp });
      }
      case "stop": { const peer = peerOf(m.peer); if (peer) stopPeer(peer); return true; }
      case "stopTab": { const t = targetOf(m.tabId); if (t) stopTab(t); return true; }
      case "resize": {
        const tabId = targetOf(m.tabId), frame = frameOf(m.frame);
        if (!tabId || !frame) return { error: "a resize is { tabId, frame }" };
        return resize({ tabId, frame });
      }
      case "take": {
        const ms = Math.max(0, Math.min(TAKE_MS_MAX, Number(m.ms) || 1000));
        return take({ ms, max: TAKE_ROOM });
      }
      case "peers": return peers();
      default: return { error: "unknown" };
    }
  }

  // ---- recording: background.js pbRecord's part, over the browser's Tabs and Windows ----
  let recording = null; // { follow, window, removers, titles, timer } while a recording runs

  const lists = async () => {
    const [{ tabs }, { windows }] = await Promise.all([pb.tabs.list(), pb.windows.list()]);
    return { tabs: Array.isArray(tabs) ? tabs : [], windows: Array.isArray(windows) ? windows : [] };
  };
  const stripOf = (all, windowId) => all.filter((t) => t.window === windowId && targetOf(t.targetId))
    .sort((a, b) => a.index - b.index)
    .map((t) => ({ id: t.targetId, title: String(t.title || t.url || ""), active: !!t.active }));
  // The tab in front: the active tab of the focused window (else the first window's).
  const frontIn = ({ tabs: all, windows }) => {
    const w = windows.find((x) => x.focused) || windows.find((x) => !x.minimized) || windows[0];
    if (!w) return null;
    return all.find((t) => t.window === w.id && t.active) || all.find((t) => t.id === w.activeTab) || null;
  };
  // The tab's picture: a capture of it unless one runs already (a capture can't be taken twice).
  // Its size in CSS pixels. streamId null: the browser refused (not an ordinary web tab).
  async function frontOf(tab, all) {
    const tabId = targetOf(tab.targetId);
    if (!tabId) return null;
    const streamId = has(tabId) ? undefined : await grant(tabId);
    return { tabId, frame: { w: tab.width || 1280, h: tab.height || 800 }, streamId: streamId ?? undefined, tabs: stripOf(all, tab.window), refused: streamId === null };
  }
  // A tab the browser won't capture (its own pages): the video keeps the last tab.
  async function show(tab, all) {
    if (!recording || !tab) return;
    const f = await frontOf(tab, all);
    if (!f || f.refused || !recording) return;
    recording.window = tab.window;
    const { refused: _r, ...m } = f;
    await record({ op: "recFront", ...m });
  }
  const showById = async (match) => {
    const l = await lists();
    await show(l.tabs.find(match) || null, l.tabs);
  };

  // The strip's tabs changed (created, closed, moved, retitled): once a burst settles.
  function stripChanged() {
    if (!recording) return;
    clearTimeout(recording.timer);
    const mine = recording;
    mine.timer = setTimeout(async () => {
      if (recording !== mine) return;
      try { const { tabs: all } = await pb.tabs.list(); if (recording === mine) await record({ op: "recTabs", tabs: stripOf(all || [], mine.window) }); } catch {}
    }, STRIP_WAIT_MS);
  }
  function observe(r) {
    const said = (t) => `${t.title}\n${t.url}`;
    r.removers.push(pb.tabs.addObserver({
      onActivated: (id) => { if (recording === r && r.follow === "front") showById((t) => t.id === id).catch(() => {}); },
      onCreated: (t) => { if (t) r.titles.set(t.id, said(t)); stripChanged(); },
      onRemoved: (id) => { r.titles.delete(id); stripChanged(); },
      onMoved: () => stripChanged(),
      onChanged: (t) => {
        if (!t || r.titles.get(t.id) === said(t)) return;
        r.titles.set(t.id, said(t));
        stripChanged();
      },
    }));
    r.removers.push(pb.windows.addObserver({
      onFocusChanged: (id) => {
        if (recording !== r || r.follow !== "front" || id === -1) return;
        showById((t) => t.window === id && t.active).catch(() => {});
      },
    }));
  }
  function end() {
    const r = recording;
    recording = null;
    if (!r) return;
    clearTimeout(r.timer);
    for (const remove of r.removers) { try { remove(); } catch {} }
  }

  async function rec(m) {
    switch (m.op) {
      case "start": {
        if (recording) return { error: "already recording" };
        const l = await lists();
        const tab = frontIn(l);
        if (!tab) return { error: "no tab in front" };
        const f = await frontOf(tab, l.tabs);
        if (!f || f.refused) return { error: "the tab in front can't be recorded" };
        const r = { follow: m.follow === "agents" ? "agents" : "front", window: tab.window, removers: [], titles: new Map(l.tabs.map((t) => [t.id, `${t.title}\n${t.url}`])), timer: 0 };
        recording = r;
        const { refused: _r, ...front } = f;
        const out = await record({ op: "recStart", ...front, labels: m.labels && typeof m.labels === "object" ? m.labels : {}, scale: m.scale });
        if (!out || out.error) { if (recording === r) end(); return out; }
        if (recording === r) observe(r);
        return out;
      }
      case "labels": {
        const extra = recording ? { tabs: stripOf((await pb.tabs.list()).tabs || [], recording.window) } : {};
        return record({ op: "recTabs", labels: m.labels && typeof m.labels === "object" ? m.labels : {}, ...extra });
      }
      case "show": {
        const target = targetOf(m.tabId);
        if (target) await showById((t) => t.targetId === target);
        return true;
      }
      case "stop": end(); return record({ op: "recStop" });
      case "chunk": {
        const offset = Math.max(0, Math.floor(Number(m.offset) || 0));
        const size = Math.max(0, Math.min(PAGE_CHUNK_BYTES, Math.floor(Number(m.size) || 0)));
        return record({ op: "recChunk", offset, size });
      }
      case "clear": end(); return record({ op: "recClear" });
      case "state": return record({ op: "recState" });
      default: return { error: "unknown" };
    }
  }

  // One call from the helper: { n, value } or { n, error }, inside the limits; null: not a call.
  async function call(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const n = data.n;
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    if (data.to !== "share" && data.to !== "record") return { n, ...fail("no such capture call") };
    let out;
    try { out = await (data.to === "share" ? share(data) : rec(data)); } catch (e) { return { n, ...fail(e) }; }
    return { n, ...bounded(out) };
  }

  return { call, share, record: rec, recording: () => !!recording };
}

// The page's channel to the helper: its own stream (common.js helperStream, kind "capture": never
// the shared one), the hello on each open, the answers posted. Returns { core, close() }.
export async function startNative(pb, { scope = globalThis, onState = () => {}, stream = helperStream } = {}) {
  const core = createNativeCapture(pb);
  let current = null, base = null, closed = false;
  const post = (body) => scope.fetch(base + "capture/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  async function helper() {
    try { const { origin, key } = (await pb.session.helper()) || {}; return origin && key ? `${origin}/${key}/` : null; } catch { return null; }
  }
  // A stream that ended for good (the helper restarted on a new key): the address is asked once
  // again, and the stream reopened only on a new one. No retry timer.
  function open(url) {
    if (closed) return;
    if (!url) { onState("closed"); return; }
    base = url;
    let mine = null;
    mine = stream(url, {
      kind: "capture",
      shared: false,
      onState: (s) => {
        onState(s);
        if (s === "closed") helper().then((next) => { if (current === mine && next && next !== url) { mine.close(); open(next); } });
      },
      onOpen: () => post({ hello: true, caps: caps(pb, scope) }),
    });
    current = mine;
    mine.on("capture", (data) => { core.call(data).then((r) => { if (r && current === mine) post(r); }); });
  }
  open(await helper());
  return { core, close() { closed = true; current?.close(); current = null; } };
}
