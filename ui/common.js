// Shared by the side panel, the browser's own pages (the strip, the docks, the timeline, the
// approval bubble, settings), the new tab page and the live view (which serves this file from
// here: an extension can load only its own files). It also holds helperStream, the one owner
// event stream those pages share per origin. The live view's server imports it in tests, so
// this module must stay free of side effects: definitions only, nothing runs on import. The words
// and colors the helper shares with the pages are in vocab.js, the browser's own addresses in
// urls.js (addressToUrl, servedByBrowser), re-exported here.
import { STATE_WORDS, PAGE_KINDS, isColor } from "./vocab.js";
import { SHARED_STREAM_EVENTS, DELTA_EVENTS, OWN_EVENTS } from "./events.js";
import { addressToUrl, servedByBrowser, REPORT_URL } from "./urls.js";
import { postJson, UNREACHABLE } from "./helper.js";
export { STATE_WORDS, isColor, addressToUrl, servedByBrowser, REPORT_URL };
import { el } from "./dom.js";
export * from "./dom.js";
import { busy } from "./motion.js";
export * from "./motion.js";
export * from "./words.js";
export * from "./people.js";
export * from "./checklist.js";
export * from "./report.js";
export * from "./panels.js";

// Share (the side panel's header, the live view's toolbar): a card under btn that makes a join
// code (shared browser, can drive) or a watch link with the owner's own key, through the
// helper's own invite code. The code or link is shown once, in a read-only field, and cleared
// when the card closes. Asks the owner's first name once (the helper says when). card holds
// the ids share-name-row, share-name, share-make, share-result, share-code, share-copy,
// share-rights and share-msg. base(): the live view address (null: not connected yet). btn may
// be null (the left dock's card, opened only by the strip's Share): open() and close() then touch
// no button; returnTo (optional) takes the focus back when it was inside the card (F6 into the
// dock, then Escape), else close() moves no focus.
// dismissable(): false while a host owns dismissal (the strip's #share bubble): no outside click or Escape closes it.
// onToggle(open) runs on every open and close (the right dock tells the strip's Share, which asked).
export function shareCard({ btn, card, base, onCopy = () => {}, dismissable = () => true, returnTo = null, onToggle = () => {} }) {
  const q = (id) => card.querySelector(`#${id}`);
  const nameRow = q("share-name-row"), name = q("share-name"), make = q("share-make"), result = q("share-result");
  const code = q("share-code"), copy = q("share-copy"), rights = q("share-rights"), msg = q("share-msg");
  const say = (text, kind = "") => { msg.textContent = text; msg.dataset.kind = kind; };
  const radios = () => [...card.querySelectorAll('input[name="share"]')];
  const outside = (e) => { if (!card.contains(e.target) && !btn?.contains(e.target)) close(false); };
  function open() {
    card.hidden = false;
    btn?.setAttribute("aria-expanded", "true");
    if (dismissable()) document.addEventListener("pointerdown", outside, true);
    (radios().find((r) => r.checked) || radios()[0])?.focus();
    onToggle(true);
  }
  function close(refocus = true) {
    if (card.hidden) return;
    card.hidden = true;
    onToggle(false);
    btn?.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    code.value = ""; rights.textContent = ""; result.hidden = true; nameRow.hidden = true; say("");
    if (refocus) btn?.focus();
    // No button to return to: focus never stays on a control the card just hid; it goes to
    // returnTo when there is one, so the next Tab goes on from there.
    else if (!btn && card.contains(document.activeElement)) {
      if (returnTo) returnTo.focus();
      else document.activeElement.blur();
    }
  }
  btn?.addEventListener("click", () => (card.hidden ? open() : close()));
  // With no button of its own (opened from another page's: the strip's Share asks the left dock)
  // nothing here takes the focus back on close: the asking control keeps it.
  const onEscape = (e) => { if (e.key === "Escape" && !card.hidden && dismissable()) { e.preventDefault(); close(!!btn); } };
  card.addEventListener("keydown", onEscape);
  btn?.addEventListener("keydown", onEscape);
  // A non-modal card: Tab out of it (not onto its button) closes it, so it never lingers.
  card.addEventListener("focusout", (e) => { if (!card.hidden && e.relatedTarget && !card.contains(e.relatedTarget) && e.relatedTarget !== btn) close(!!btn); });
  // A person's click or key press only: a synthetic event makes nothing.
  async function makeInvite() {
    if (make.disabled) return;
    if (!base()) return say("Not connected to PairBrowse yet.", "error");
    const share = radios().find((r) => r.checked)?.value === "link" ? "link" : "code";
    const given = name.value.trim();
    make.disabled = true;
    say("");
    const r = await busy(make, () => postJson(base() + "invite", { share, ...(given ? { name: given } : {}) }).then((x) => x.json()).catch(() => ({ error: UNREACHABLE })));
    make.disabled = false;
    if (r?.needName) { nameRow.hidden = false; name.focus(); return say(r.error || "Your first name, please.", "error"); }
    if (!r?.ok) return say(r?.error || "Couldn't make the invite.", "error");
    nameRow.hidden = true;
    code.value = r.code || r.link || "";
    rights.textContent = [r.rights, r.hint].filter(Boolean).join(" ");
    result.hidden = false;
    say(share === "code" ? "Join code made. Send it yourself; it's shown here only now." : "Watch link made. Send it yourself; it's shown here only now.", "ok");
    code.focus();
    code.select();
  }
  make.addEventListener("click", (ev) => { if (ev.isTrusted) makeInvite(); });
  name.addEventListener("keydown", (e) => { if (e.isTrusted && e.key === "Enter") { e.preventDefault(); makeInvite(); } });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      say("Copied.", "ok");
      onCopy(code.value);
    } catch {
      code.focus();
      code.select();
      say("Select and press Ctrl/Cmd+C to copy.", "error");
    }
  });
  return { open, close, isOpen: () => !card.hidden };
}

// The session switcher (the strip's chevron, the left dock's Workspace header and Sessions row):
// ui/picker in a same-origin iframe inside pop, loaded only while open and unloaded on close. It
// closes on the picker's "picked" or "close" notice (from that frame and this origin only), on
// Escape and on a click outside pop and every opener; focus goes back to the opener that opened
// it, except after a click outside. The parent never posts to the frame. openers: the buttons
// that toggle it (each gets aria-expanded). dismissable(): false while a host owns dismissal (the
// strip's #switcher bubble): no notice, Escape or outside click closes it then.
// onToggle(open) runs on every open and close (the left dock tells the strip's logo, which asked).
// noHelper(): true when the parent knows there is no helper to ask; the frame then opens as
// picker/index.html#none and shows the resting state (a frame in a slot gets no Session binding
// of its own, DESIGN.md H4.1, so it can't tell by itself). The hash carries no key or name.
// The frame unloads once the popover has faded out (at once under reduced motion).
export function pickerPopover({ pop, frame, openers, dismissable = () => true, onToggle = () => {}, noHelper = () => false }) {
  let opener = null;
  const isOpen = () => !pop.hidden;
  const outside = (e) => { if (dismissable() && !pop.contains(e.target) && !openers.some((b) => b.contains(e.target))) close(false); };
  const onMessage = (e) => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
    if (e.data?.source !== "pairbrowse-picker" || (e.data.op !== "picked" && e.data.op !== "close")) return;
    if (dismissable()) close(true);
  };
  function open(by) {
    if (isOpen()) return;
    opener = by || openers[0];
    frame.src = noHelper() ? "../picker/index.html#none" : "../picker/index.html";
    pop.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    if (dismissable()) document.addEventListener("pointerdown", outside, true);
    window.addEventListener("message", onMessage);
    frame.focus();
    onToggle(true);
  }
  function close(refocus = true) {
    if (!isOpen()) return;
    pop.hidden = true;
    const unload = () => { if (pop.hidden) frame.removeAttribute("src"); };
    const fading = pop.getAnimations?.() || [];
    if (fading.length) Promise.all(fading.map((a) => a.finished)).then(unload, unload); else unload();
    onToggle(false);
    opener?.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("message", onMessage);
    if (refocus) opener?.focus();
  }
  const onEscape = (e) => { if (e.key === "Escape" && isOpen() && dismissable()) { e.preventDefault(); close(); } };
  for (const b of openers) {
    b.addEventListener("click", () => (isOpen() ? close() : open(b)));
    b.addEventListener("keydown", onEscape);
  }
  pop.addEventListener("keydown", onEscape);
  return { open, close, isOpen };
}

// The question POST pick answers with 428 while other agents are at work ({ text, error, confirm:
// "<question>", agents: [names] }): asked in the page itself, since a page in a dock slot gets no
// confirm() dialog. box: the card's element (emptied and hidden once answered). The question is
// the helper's own; agents it doesn't name are listed under it. Only a person's own click or key
// press answers: yes() resends the same pick with confirm: true, no() drops it. -> the Cancel path
// (for Escape).
export function askSwitch(box, r, { yes, no }) {
  const agents = Array.isArray(r?.agents) ? r.agents.filter((a) => typeof a === "string" && a.trim()).map((a) => a.slice(0, 60)).slice(0, 8) : [];
  const many = agents.length !== 1;
  const question = typeof r?.confirm === "string" && r.confirm.trim() ? r.confirm.slice(0, 300)
    : `${agents.length ? agents.join(", ") : "Agents"} ${many ? "are" : "is"} using the browser. Switching closes every tab for them. Switch anyway?`;
  const unnamed = agents.filter((a) => !question.includes(a));
  const go = el("button", { className: "primary", type: "button", textContent: "Switch anyway" });
  const cancel = el("button", { className: "secondary", type: "button", textContent: "Cancel" });
  let done = false;
  const finish = (fn) => {
    if (done) return;
    done = true;
    box.hidden = true;
    box.replaceChildren();
    fn();
  };
  go.addEventListener("click", (ev) => { if (ev.isTrusted) finish(yes); });
  cancel.addEventListener("click", (ev) => { if (ev.isTrusted) finish(no); });
  box.replaceChildren(el("strong", { textContent: question }),
    ...(unnamed.length ? [el("small", { className: "agents", textContent: `At work: ${agents.join(", ")}` })] : []),
    el("span", { className: "buttons" }, go, cancel));
  box.hidden = false;
  cancel.focus();
  return () => finish(no);
}

// Asks for one dock's state: the browser's Layout.Set in the build (the last state with one side
// changed), else the helper's POST layout; false when neither channel is there (nothing asked).
const DOCK_STATE = { hidden: "kHidden", rail: "kRail", open: "kOpen" };
export function askDock({ pb, layout, base, side, state, onFail }) {
  if (pb) {
    if (!layout) return false;
    pb.layout.set({ ...layout, [side]: pb.DockState[DOCK_STATE[state]] }).catch(() => onFail?.());
    return true;
  }
  if (!base) return false;
  postJson(base + "layout", { [side]: state }).then((r) => { if (!r.ok) onFail?.(); }, () => onFail?.());
  return true;
}

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
