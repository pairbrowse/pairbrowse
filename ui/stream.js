// The helper's event stream, one per origin: the only EventSource the pages open (ui.test checks).
// Shared by the pages and the window preview (common.js re-exports it; the live view serves it). A
// flat file at the ui/ root; definitions only, nothing runs on import.
import { PAGE_KINDS } from "./vocab.js";
import { SHARED_STREAM_EVENTS, DELTA_EVENTS, OWN_EVENTS } from "./events.js";

// ---- the helper's event stream, one per origin ----
// Why one: a browser opens at most 6 connections per host, and the window's slot pages alone are
// 7 (the strip, its two nav fragments, the left and right docks, the timeline, the approval
// bubble), so a stream each would leave a page waiting for a connection that never comes. A Web
// Lock named after the helper's address (its origin: no key in it) picks one page, which opens
// the owner stream (events?panel=1, never a viewer) and relays every event over a
// BroadcastChannel of the same name; the other pages listen. When that page closes, is frozen or
// hides, the lock passes and the next page opens the stream. The lock and the channel are scoped
// to the page's own origin, so a web page, another extension or the live view page can neither
// take the lock nor hear the channel. Owner-only filtering stays the helper's: the same events
// reach the same pages. A page that joins late gets the last value of each state event from the
// page holding the stream; deltas (approval, timeline, downloads, handoffs, a tab-order request) are never replayed:
// pages fetch their snapshot in onOpen. One-shot fields are never replayed either: a layout
// event's `tab` (the right dock opening on a tab) and a record event's `op` ("saved", with its
// item), so a late page neither jumps to a tab nor adds a recording from an old event. Without Web Locks or BroadcastChannel (or when the lock is refused) a page
// opens its own stream as before. No timer, frame or observer anywhere here.
// The names come from events.js, the one list of the helper's events (pages: "shared", delta).
export const STREAM_EVENTS = SHARED_STREAM_EVENTS;
const STREAM_DELTAS = new Set(DELTA_EVENTS);
// What the holder keeps of a state event for a late page: no delta, and no one-shot field.
function replayable(name, v) {
  if (STREAM_DELTAS.has(name)) return undefined;
  const obj = v && typeof v === "object" && !Array.isArray(v);
  if (name === "layout" && obj && "tab" in v) { const { tab, ...rest } = v; return rest; }
  if (name === "record" && obj && "op" in v) {
    // A saved notice alone is never kept; one that also says the recording state keeps the state.
    if (typeof v.recording !== "boolean") return undefined;
    const { op, item, ...rest } = v;
    return rest;
  }
  return v;
}
// Events one page kind's own stream carries and no other page hears: never on the shared stream,
// never relayed or replayed. The capture page's calls from the helper (`capture`, plans/550 D4:
// SDPs and recordings for the capture page alone). A page of such a kind always gets a stream of
// its own (helperStream below), whatever it asks.
export const OWN_STREAM_EVENTS = OWN_EVENTS;

// The helper's page kinds: one of them on the stream gets the browser pages' initial burst
// (agent-tabs); the helper sends the same burst to every kind, so one kind stands for all.
const STREAM_KINDS = new Set(PAGE_KINDS);

// One EventSource to the helper: event(name, parsed data) for every STREAM_EVENTS name (a body
// that is not JSON is dropped), state("live" | "connecting" | "closed").
// own: the kind's OWN_STREAM_EVENTS too (a page's own stream only).
function openStream(base, kind, { event, state }, own = []) {
  const es = new EventSource(base + "events?panel=1" + (kind ? `&page=${kind}` : ""));
  es.onopen = () => state("live");
  es.onerror = () => state(es.readyState === EventSource.CLOSED ? "closed" : "connecting");
  for (const name of [...STREAM_EVENTS, ...own]) {
    es.addEventListener(name, (e) => { let v; try { v = JSON.parse(e.data); } catch { return; } event(name, v); });
  }
  return es;
}

// helperStream(base, { kind, shared, onState, onOpen }) -> { on(name, fn), close() }. base: the
// helper's `${origin}/${key}/`. kind: the page's own helper page kind, or "". shared: false opens a
// stream of this page's own, never the origin's shared one: the helper counts a page kind only
// from the stream that carries it, so a page that must count on its own (the approval bubble, 530
// D2) says so; a kind with OWN_STREAM_EVENTS (the capture page) always does, and only its own
// stream delivers those events. onState(s) on every state change; onOpen() each time the stream goes live (fetch
// snapshots there). Nothing is delivered during the call itself, so on() calls made right after it
// miss nothing.
export function helperStream(base, { kind = "", shared = true, onState = () => {}, onOpen = () => {} } = {}) {
  const handlers = new Map(); // event name -> [fn]
  const on = (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); };
  const deliver = (name, data) => {
    for (const fn of handlers.get(name) || []) {
      try { fn(data); } catch (e) { reportError(e); } // one handler never stops the relay
    }
  };
  let state = "connecting";
  const setState = (s) => {
    const was = state;
    state = s;
    onState(s);
    if (s === "live" && was !== "live") onOpen();
  };
  const ownKind = STREAM_KINDS.has(kind) ? kind : "";
  const ownEvents = Object.hasOwn(OWN_STREAM_EVENTS, ownKind) ? OWN_STREAM_EVENTS[ownKind] : [];
  if (ownEvents.length) shared = false;
  let closed = false;
  let es = null;

  // A stream of this page's own (shared: false, no Web Locks or BroadcastChannel, or the lock refused).
  function own() {
    if (closed) return;
    es = openStream(base, ownKind, { event: deliver, state: setState }, ownEvents);
  }

  let name = "";
  try { name = "pairbrowse-stream " + new URL(base).origin; } catch { name = ""; }
  if (!shared || !name || typeof navigator.locks?.request !== "function" || typeof BroadcastChannel !== "function" || typeof crypto?.randomUUID !== "function") {
    // The first delivery still comes from the stream's own callbacks, never from this call.
    own();
    return { on, close() { closed = true; es?.close(); es = null; } };
  }

  let cur = base; // the newest address announced under this name
  // When cur was learned: a holder takes on another address only from a hello that learned it
  // later, so a page still on a dead key (back from the cache, or resumed) never moves the stream.
  let since = performance.timeOrigin + performance.now();
  const id = crypto.randomUUID();
  const ch = new BroadcastChannel(name);
  const post = (msg) => { try { ch.postMessage(msg); } catch {} };
  const cache = new Map(); // state event name -> its last value (the holder's)
  let holder = false;
  let release = null; // resolves the lock callback's promise
  let ctl = null; // aborts a pending lock request
  let streamKind = ownKind;

  // The holder: one stream, every event delivered here and posted to the others.
  // A stream that ends for good gives the lock up, so a page on a live address can take it.
  const shareState = (s) => {
    setState(s);
    post({ t: "state", base: cur, s });
    if (s === "closed" && holder) suspend();
  };
  function openHeld() {
    es?.close();
    cache.clear();
    shareState("connecting");
    es = openStream(cur, streamKind, {
      event: (n, v) => {
        deliver(n, v);
        const kept = replayable(n, v);
        if (kept !== undefined) cache.set(n, kept);
        post({ t: "event", base: cur, name: n, data: v });
      },
      state: shareState,
    });
  }
  function request() {
    if (closed || ctl || holder) return;
    const c = new AbortController();
    ctl = c;
    navigator.locks.request(name, { signal: c.signal }, () => new Promise((resolve) => {
      ctl = null;
      if (closed) { resolve(); return; }
      holder = true;
      release = resolve;
      openHeld();
    })).catch((e) => {
      if (ctl === c) ctl = null;
      if (e?.name === "AbortError" || closed) return;
      // The lock refused: a stream of this page's own, as before.
      holder = false;
      ch.onmessage = null;
      try { ch.close(); } catch {}
      own();
    });
  }
  // Frozen or hidden for good: the stream and the lock go to the next page.
  function suspend() {
    ctl?.abort();
    ctl = null;
    if (!holder) return;
    holder = false;
    es?.close();
    es = null;
    const r = release;
    release = null;
    r?.();
  }
  function resume() {
    if (closed) return;
    post({ t: "hello", id, base: cur, kind, since });
    request();
  }

  ch.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (holder) {
      if (m.t !== "hello" || typeof m.base !== "string") return;
      if (m.base !== cur) {
        // A helper restarted: the newer address wins, the old key is dead. An older one is ignored.
        if (typeof m.since === "number" && m.since > since) { cur = m.base; since = m.since; openHeld(); }
        return;
      }
      if (!streamKind && STREAM_KINDS.has(m.kind)) { streamKind = m.kind; openHeld(); return; }
      post({ t: "state", base: cur, s: state, to: m.id });
      for (const [n, data] of cache) post({ t: "event", base: cur, name: n, data, to: m.id });
      return;
    }
    if (m.base !== cur || (m.to !== undefined && m.to !== id)) return;
    if (m.t === "state" && typeof m.s === "string") setState(m.s);
    else if (m.t === "event" && typeof m.name === "string") deliver(m.name, m.data);
  };
  const onFreeze = () => suspend();
  const onResume = () => resume();
  const onPageHide = () => suspend();
  const onPageShow = (e) => { if (e.persisted) resume(); };
  document.addEventListener("freeze", onFreeze);
  document.addEventListener("resume", onResume);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  post({ t: "hello", id, base: cur, kind, since });
  request();

  return {
    on,
    close() {
      if (closed) return;
      closed = true;
      ctl?.abort();
      ctl = null;
      es?.close();
      es = null;
      holder = false;
      const r = release;
      release = null;
      r?.();
      ch.onmessage = null;
      try { ch.close(); } catch {}
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    },
  };
}
