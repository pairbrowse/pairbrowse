// Shared browser mode, on the host: one browser for everyone. A joiner sees the host's tabs live
// and works in them (clicks, keys, wheel, pasted text), logged in as the host is, and nothing of
// the session is copied to their computer but the picture. The picture and sound go peer to peer
// (the extension's share.js, WebRTC); only the connection's setup goes over the join channel.
// What a joiner does comes back on that connection; it's checked here and replayed in the tab
// through CDP, like the live view's input (liveview/input.mjs).
// call(fn, arg, ms): runs fn(arg) in the side panel extension's worker (panel.mjs).
import { createInputReplayer } from "../liveview/input.mjs";
import { within } from "../util.mjs";

export const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];
const FRAME_MAX = 1920; // the picture's longer side, in pixels
const VIEW_EVERY_MS = 250; // the tab's size and scroll are read again this often (pointers follow scrolling)
const TAKE_MS = 1000;
const KEY_TEXT = /^.$/u;
const CODES = { Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Meta: 91 };

// The picture's size for a tab of w x h CSS pixels at dpr: its own shape, at most FRAME_MAX a side.
export function frameFor(w, h, dpr = 1) {
  const pw = Math.max(2, Math.round(w * dpr)), ph = Math.max(2, Math.round(h * dpr));
  const s = Math.min(1, FRAME_MAX / Math.max(pw, ph));
  const even = (n) => Math.max(2, Math.round(n * s / 2) * 2);
  return { w: even(pw), h: even(ph) };
}

// One event from a joiner's page (screen.js), checked, as CSS pixels in a view of w x h; null when
// it isn't one. Keys keep to what one key press sends; the host's clipboard is never used.
export function readInput(ev, view) {
  if (!ev || typeof ev !== "object" || !view?.w) return null;
  const at = () => {
    const nx = Number(ev.nx), ny = Number(ev.ny);
    if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return null;
    return { x: Math.round(nx * view.w * 10) / 10, y: Math.round(ny * view.h * 10) / 10 };
  };
  const m = Number.isInteger(ev.m) ? ev.m & 15 : 0;
  if (ev.t === "mouse" && ["mouseMoved", "mousePressed", "mouseReleased"].includes(ev.a)) {
    const p = at();
    if (!p) return null;
    const buttons = Number.isInteger(ev.bs) ? ev.bs & 7 : 0;
    // A move while a button is down is a drag (drawing on a canvas, selecting text).
    const button = ["left", "middle", "right"].includes(ev.b) ? ev.b : ev.a === "mouseMoved" && buttons & 1 ? "left" : "none";
    return { type: "mouse", action: ev.a, ...p, button, buttons, clickCount: ev.a === "mouseMoved" ? 0 : Math.min(3, Math.max(1, Number(ev.c) || 1)), modifiers: m };
  }
  if (ev.t === "wheel") {
    const p = at();
    if (!p) return null;
    const d = (n) => Math.max(-5000, Math.min(5000, Math.round(Number(n) || 0)));
    return { type: "wheel", ...p, dx: d(ev.dx), dy: d(ev.dy) };
  }
  if (ev.t === "text" && typeof ev.text === "string" && ev.text) return { type: "text", text: ev.text.slice(0, 2000) };
  if (ev.t === "key" && (ev.a === "down" || ev.a === "up") && typeof ev.key === "string" && ev.key.length <= 32) {
    // Shortcuts that would use the host's clipboard (copy, cut, paste) never reach the page.
    if (m & 6 && /^[cxv]$/i.test(ev.key)) return null;
    const code = typeof ev.code === "string" ? ev.code.slice(0, 32) : "";
    const text = ev.a === "down" && KEY_TEXT.test(ev.key) && !(m & 6) ? ev.key : ev.key === "Enter" && ev.a === "down" ? "\r" : "";
    return { type: "rawkey", action: ev.a, key: ev.key, code, keyCode: Number(ev.kc) > 0 && Number(ev.kc) < 256 ? Number(ev.kc) : CODES[ev.key] || (text ? text.toUpperCase().charCodeAt(0) : 0), text, location: [0, 1, 2, 3].includes(ev.loc) ? ev.loc : 0, repeat: !!ev.rep, modifiers: m };
  }
  return null;
}

// What a joiner did, for the agents here (they wait while a person acts in the tab) and the bar.
const describe = (ev) => ev.type === "mouse" ? (ev.action === "mousePressed" ? "clicked on the page" : null)
  : ev.type === "wheel" ? "scrolled" : ev.type === "text" || ev.type === "rawkey" ? (ev.action === "up" ? null : "typed") : null;

// call: the extension worker. getContext(): the browser. log.
// during(who): marks a joiner's input while it's replayed (presence.remoteStart; returns done()).
export function createScreenShare({ call, log = () => {}, during = () => () => {} }) {
  const peers = new Map(); // peer -> { page, tabId, view, frame, onInput, onState, role }
  const sessions = new Map(); // page -> { cdp, replayer, view, viewAt }
  let looping = false;

  const ext = (fn, arg, ms = 8000) => call(fn, arg, ms);

  async function session(page) {
    let s = sessions.get(page);
    if (s) return s;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable").catch(() => {}); // page events (file dialogs, screencast frames) come only then
    const replayer = createInputReplayer();
    await replayer.attach(cdp);
    s = { cdp, replayer, view: null, viewAt: 0 };
    sessions.set(page, s);
    page.once("close", () => { sessions.delete(page); watchers.delete(page); for (const [peer, p] of peers) if (p.page === page) stop(peer); });
    return s;
  }
  // The tab's size in CSS pixels and its scroll (for pointers), read at most once a second.
  async function viewOf(page, fresh = false) {
    const s = await session(page);
    if (fresh || !s.view || Date.now() - s.viewAt > VIEW_EVERY_MS) {
      const v = await within(1500, page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY]).catch(() => null));
      if (v) { s.view = { w: v[0], h: v[1], dpr: v[2], sx: v[3], sy: v[4] }; s.viewAt = Date.now(); }
    }
    return s.view;
  }
  async function tabIdOf(page) {
    const cdp = await page.context().newCDPSession(page);
    let targetId;
    try { ({ targetInfo: { targetId } } = await cdp.send("Target.getTargetInfo")); } finally { cdp.detach().catch(() => {}); }
    return ext((t) => { if (!globalThis.pbTabId) throw new Error("not ready"); return globalThis.pbTabId(t); }, targetId);
  }

  // Input from the extension (what joiners did), for as long as anyone is connected.
  // While anyone watches a tab, its size and scroll stay fresh (pointers drawn over the picture).
  let viewTimer = null;
  const keepViews = () => {
    if (viewTimer) return;
    viewTimer = setInterval(() => {
      const pages = new Set([...[...peers.values()].map((x) => x.page), ...watchers.keys()]);
      if (!pages.size) { clearInterval(viewTimer); viewTimer = null; return; }
      for (const page of pages) if (!page.isClosed()) viewOf(page).catch(() => {});
    }, VIEW_EVERY_MS);
    viewTimer.unref?.();
  };
  async function loop() {
    keepViews();
    if (looping) return;
    looping = true;
    try {
      while (peers.size) {
        const items = await within(TAKE_MS + 3000, ext((a) => globalThis.pbShare(a), { op: "take", ms: TAKE_MS }, TAKE_MS + 2000)).catch(() => null);
        if (!Array.isArray(items)) { await new Promise((r) => setTimeout(r, 300)); continue; }
        for (const item of items) await handle(item).catch((e) => log("shared screen", e?.message || e));
        await resizeAll().catch(() => {});
      }
    } finally {
      looping = false;
    }
  }
  async function handle(item) {
    const p = peers.get(String(item?.peer || ""));
    if (!p) return;
    if (item.state) {
      try { p.onState?.(item.state); } catch {}
      // A connection that failed or closed is gone for good (the extension drops it too).
      if (item.state === "failed" || item.state === "closed") await stop(String(item.peer));
      return;
    }
    if (p.role !== "drive") return; // watching: the picture only
    await replay(p.page, item.ev, p.onInput, p.who, p.onPick);
  }
  // A file dialog a joiner's click or key opens is theirs: taken here as it opens (never shown on
  // this computer, and never left waiting for the agents' tools, which would block them) and
  // handed to the joiner (onPick). Only for a moment after their input: the host's own clicks
  // work as usual.
  const PICK_MS = 1500;
  function catchPicker(page, s, onPick) {
    s.pickUntil = Date.now() + PICK_MS;
    s.onPick = onPick;
    if (page.__pbPicker) return;
    page.__pbPicker = true;
    const emit = page.emit.bind(page);
    page.emit = (event, ...args) => {
      if (event === "filechooser" && Date.now() <= (s.pickUntil || 0) && s.onPick) {
        log("shared browser: a joiner opened a file dialog; asking them");
        try { s.onPick({ chooser: args[0], multiple: !!args[0]?.isMultiple?.() }); } catch {}
        return true;
      }
      return emit(event, ...args);
    };
  }
  async function replay(page, raw, onInput, who = "", onPick = null) {
    const view = await viewOf(page);
    const ev = readInput(raw, view);
    if (!ev) return;
    const s = await session(page);
    if (onPick && ((ev.type === "mouse" && ev.action !== "mouseMoved") || (ev.type === "rawkey" && ev.action === "down" && (ev.key === "Enter" || ev.key === " ")))) catchPicker(page, s, onPick);
    const done = during(who);
    try {
      if (ev.type === "rawkey") await rawKey(s.cdp, ev);
      else await s.replayer.replay({ page, cdp: s.cdp }, ev, "drive");
    } finally {
      done();
    }
    try { onInput?.(ev, describe(ev), view); } catch {}
  }

  // The slower route (no direct connection): JPEG pictures of the tab, as the page changes, to
  // each joiner watching it that way. watchers: page -> Map(key -> onFrame).
  const watchers = new Map();
  async function frames(page, key, onFrame) {
    let w = watchers.get(page);
    if (!onFrame) {
      // Stopping never opens a session: the tab may have closed already.
      if (!w) return;
      w.delete(key);
      if (w.size) return;
      watchers.delete(page);
      const s = sessions.get(page);
      if (!s) return;
      await s.cdp.send("Page.stopScreencast").catch(() => {});
      if (s.onFrame) s.cdp.off("Page.screencastFrame", s.onFrame);
      s.onFrame = null;
      return;
    }
    const s = await session(page);
    w = watchers.get(page);
    if (!w) {
      w = new Map();
      watchers.set(page, w);
      s.onFrame = ({ data, sessionId }) => {
        s.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        for (const fn of (watchers.get(page) || new Map()).values()) { try { fn(data); } catch {} }
      };
      s.cdp.on("Page.screencastFrame", s.onFrame);
      await s.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
    }
    w.set(key, onFrame);
    keepViews();
  }
  // One key as a person presses it: down (with its text) and up, so pages that listen for keys
  // (games, typing tests, editors, shortcuts) get them.
  async function rawKey(cdp, ev) {
    const base = { key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.keyCode, nativeVirtualKeyCode: ev.keyCode, location: ev.location, modifiers: ev.modifiers, autoRepeat: ev.repeat };
    if (ev.action === "down") await cdp.send("Input.dispatchKeyEvent", { type: ev.text ? "keyDown" : "rawKeyDown", ...base, ...(ev.text ? { text: ev.text, unmodifiedText: ev.text } : {}) });
    else await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  // The host's window changed size: the pictures follow its shape.
  async function resizeAll() {
    for (const p of new Set([...peers.values()].map((x) => x.page))) {
      const v = await viewOf(p);
      if (!v) continue;
      const frame = frameFor(v.w, v.h, v.dpr);
      const tabId = [...peers.values()].find((x) => x.page === p)?.tabId;
      if (tabId == null) continue;
      const any = [...peers.values()].find((x) => x.page === p);
      if (any.frame.w === frame.w && any.frame.h === frame.h) continue;
      for (const x of peers.values()) if (x.page === p) x.frame = frame;
      await ext((a) => globalThis.pbShare(a), { op: "resize", tabId, frame });
    }
  }

  async function stop(peer) {
    const p = peers.get(peer);
    if (!p) return;
    peers.delete(peer);
    await ext((a) => globalThis.pbShare(a), { op: "stop", peer }).catch(() => {});
  }

  return {
    // Starts sending a tab to one joiner's page: the offer (SDP) to pass on. role: their invite's.
    // onInput(ev, line, view): they did something there (replayed already). onState(state): the
    // direct connection's state ("connected", "failed", ...).
    async offer(page, peer, { role = "watch", who = "", onInput, onState, onPick } = {}) {
      await stop(peer);
      const view = await viewOf(page, true);
      if (!view) throw new Error("the tab didn't answer");
      const tabId = await tabIdOf(page);
      if (tabId == null) throw new Error("the tab can't be found");
      const frame = frameFor(view.w, view.h, view.dpr);
      const r = await ext((a) => { if (!globalThis.pbShare) throw new Error("not ready"); return globalThis.pbShare(a); }, { op: "offer", peer, tabId, frame, ice: ICE_SERVERS }, 15_000);
      if (!r?.sdp) throw new Error(r?.error || "no offer");
      peers.set(peer, { page, tabId, view, frame, onInput, onState, onPick, role, who });
      loop().catch((e) => log("shared screen", e?.message || e));
      return { sdp: r.sdp };
    },
    async answer(peer, sdp) {
      if (!peers.has(peer) || typeof sdp !== "string" || sdp.length > 100_000) return false;
      const r = await ext((a) => globalThis.pbShare(a), { op: "answer", peer, sdp });
      return r === true;
    },
    stop,
    frames,
    // Input that came through the join channel (the slower route): checked and replayed the same way.
    async input(page, events, onInput, who = "", onPick = null) { for (const ev of events) await replay(page, ev, onInput, who, onPick).catch((e) => log("shared screen", e?.message || e)); },
    // Files a joiner picked (already on this computer, in their folder) into the dialog their click opened.
    async setFiles(chooser, files) { await chooser.setFiles(files); },
    // Every connection whose peer name starts with prefix (a joiner who left), and their pictures
    // on the slower route (prefix: "<joiner key>|").
    async stopAll(prefix = "") {
      for (const peer of [...peers.keys()]) if (peer.startsWith(prefix)) await stop(peer);
      const key = prefix.replace(/\|$/, "");
      for (const page of [...watchers.keys()]) if (watchers.get(page)?.has(key)) await frames(page, key, null);
    },
    // The same as viewPoint, from what was read last (no waiting): for pointers, many a second.
    viewCached(page, x, y) {
      const v = sessions.get(page)?.view;
      if (!v) return null;
      const nx = (x - v.sx) / v.w, ny = (y - v.sy) / v.h;
      return nx < 0 || ny < 0 || nx > 1 || ny > 1 ? null : { nx: Math.round(nx * 10000) / 10000, ny: Math.round(ny * 10000) / 10000 };
    },
    peersOf: (prefix = "") => [...peers.keys()].filter((p) => p.startsWith(prefix)),
    // Where a pointer at document position (x, y) stands in the tab's view, as fractions (for the
    // pictures' overlay on joiners' side); null when out of view or unknown.
    async viewPoint(page, x, y) {
      const v = await viewOf(page);
      if (!v) return null;
      const nx = (x - v.sx) / v.w, ny = (y - v.sy) / v.h;
      return nx < 0 || ny < 0 || nx > 1 || ny > 1 ? null : { nx: Math.round(nx * 10000) / 10000, ny: Math.round(ny * 10000) / 10000 };
    },
    async close() { clearInterval(viewTimer); viewTimer = null; for (const peer of [...peers.keys()]) await stop(peer); for (const s of sessions.values()) s.cdp.detach().catch(() => {}); sessions.clear(); },
  };
}
