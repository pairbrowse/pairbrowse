  // What you do in the page yourself, in every frame (card fields and 2FA codes often sit in one):
  // which button or field, never what you type. The helper waits on it ("user-wait": answered
  // at the first input, or empty after a while), drops what happened during Claude's own
  // actions, and checks every entry. Built from functions saved here, before the page's own
  // scripts run, so a page can't bend them.
  const now = Date.now.bind(Date);
  const setTimer = setTimeout.bind(window), clearTimer = clearTimeout.bind(window);
  let userEvents = [];
  let lastMove = 0, lastWheel = 0;
  // The helper's wait for input, if one is open: answered as soon as anything is recorded.
  let waiter = null; // { resolve, timer }
  const wake = () => { if (!waiter) return; const w = waiter; waiter = null; clearTimer(w.timer); w.resolve(drainUser()); };
  function waitUser(ms) {
    if (userEvents.length) return drainUser();
    if (waiter) { const w = waiter; waiter = null; clearTimer(w.timer); w.resolve([]); } // one wait at a time
    const wait = Math.min(30000, Math.max(100, Number(ms) || 5000));
    return new Promise((resolve) => { const timer = setTimer(() => { if (waiter?.resolve === resolve) { waiter = null; resolve(drainUser()); } }, wait); waiter = { resolve, timer }; });
  }
  const CONTROL = 'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [role="option"]';
  function named(el) {
    if (!el) return "";
    if (el.type === "password") return "a password field";
    const label = el.getAttribute?.("aria-label") || (el.labels && el.labels[0]?.innerText) || el.getAttribute?.("placeholder") || el.getAttribute?.("title") ||
      (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.getAttribute("name") : el.innerText) || "";
    return String(label).trim().replace(/\s+/g, " ").slice(0, 60);
  }
  // at: the pointer event of a press far from the agent's target: where it landed (document
  // pixels), so the helper can tell it from an agent's own press whose cursor came late.
  function record(kind, what, far = false, at = null) {
    if (userEvents.length >= 60) return;
    const ev = { t: now(), kind, what };
    if (far) { ev.far = true; if (at) { ev.x = Math.round(at.clientX + scrollX); ev.y = Math.round(at.clientY + scrollY); } }
    userEvents[userEvents.length] = ev;
    wake();
  }
  // A press well away from what the agent is acting on: a person's, even while an agent's action
  // runs. What PairBrowse is about to press is declared first ("press": the box of the element,
  // or the spot, kept PRESS_KEEP_MS; its own popup closer declares the dismiss button the same
  // way), so a press inside a declared box is the agent's whatever its cursor animation is doing.
  // Without a declaration the cursor's target (last placed by the helper) and a form fill's
  // targets tell; with nothing declared at all nothing is far (the helper judges by time alone).
  const FAR_PX = 48;
  const PRESS_KEEP_MS = 8000;
  const outside = (b, x, y) => x < b.x - FAR_PX || x > b.x + b.w + FAR_PX || y < b.y - FAR_PX || y > b.y + b.h + FAR_PX;
  const awayFromAgent = (e) => {
    const n = now();
    const x = e.clientX + scrollX, y = e.clientY + scrollY;
    agentPresses = agentPresses.filter((p) => n < p.until);
    if (agentPresses.some((p) => !outside(p, x, y))) return false;
    if (agentTargets && n - agentTargets.t < 60_000 && agentTargets.list.some((t) => !outside(t, x, y))) return false;
    const b = agentBox && n - agentBox.t <= 15_000 ? agentBox : null;
    if (b && !outside(b, x, y)) return false;
    return !!(b || agentPresses.length);
  };
  function drainUser() {
    const out = userEvents;
    userEvents = [];
    return out;
  }
  const opts = { capture: true, passive: true };
  // Pages that require Trusted Types (YouTube, Google's apps) refuse plain strings as HTML, which
  // left them without the bar, cursor and pointers. PairBrowse's own fixed templates (values in
  // them escaped) go through a policy of its own, kept in here; where a page allows no new policy,
  // plain strings as before.
  let ttPolicy = null;
  try { ttPolicy = globalThis.trustedTypes?.createPolicy?.(`pairbrowse-${Math.random().toString(36).slice(2)}`, { createHTML: (x) => x }) || null; } catch {}
  const html = (x) => (ttPolicy ? ttPolicy.createHTML(x) : x);
  // The element really under the pointer or holding focus, also inside shadow DOM.
  const control = (e) => { for (const el of e.composedPath()) if (el.matches?.(CONTROL)) return el; return null; };
  const focused = () => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el; };
  // PairBrowse's own bar (its "Pause agents" button) is never input in the page.
  let barHost;
  const ours = (e) => !!barHost && e.composedPath().includes(barHost);
  // A press on a scrollbar (the page's, or a scrolling box's) is reading, like the wheel: it holds
  // nobody up. Same for scrolling keys outside a field.
  const onScrollbar = (e) => {
    const root = document.documentElement;
    if (e.clientX >= root.clientWidth || e.clientY >= root.clientHeight) return true;
    const el = e.composedPath()[0];
    if (!el || el.nodeType !== 1 || el === root || el === document.body) return false;
    const r = el.getBoundingClientRect();
    return (el.scrollHeight > el.clientHeight && e.clientX - r.left >= el.clientLeft + el.clientWidth) ||
      (el.scrollWidth > el.clientWidth && e.clientY - r.top >= el.clientTop + el.clientHeight);
  };
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);
  addEventListener("pointerdown", (e) => { if (e.isTrusted && !ours(e)) { if (onScrollbar(e)) record("scroll", ""); else record("click", named(control(e)), awayFromAgent(e), e); } }, opts);
  addEventListener("keydown", (e) => {
    if (!e.isTrusted || ours(e)) return;
    const el = focused();
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) record("type", named(el));
    else if (SCROLL_KEYS.has(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) record("scroll", "");
    else if (e.key.length > 1 && !/^(Shift|Control|Alt|Meta|CapsLock|AltGraph|Fn|OS)$/.test(e.key)) record("key", e.key); // Enter, Escape, Tab: never the letters, nor a modifier alone
  }, opts);
  // A wheel is a person's, unless an agent's scroll step just put its cursor here (agentAt): it
  // wheels in small steps right after. Plain scroll events aren't counted: pages scroll themselves
  // (menus, smooth scrolling) and Claude's clicks bring buttons into view.
  addEventListener("wheel", (e) => { const n = now(); if (n - agentAt < 1500) return; personAt = n; if (e.isTrusted && n - lastWheel > 800) { lastWheel = n; record("wheel", ""); } }, opts);
  // Where the person is reading (the top of their viewport and its height, in document pixels):
  // a shared tab marks it on the other side's scrollbar. Taken from scrolling that follows their
  // own input (wheel, keys, a press on the scrollbar, touch), never the page's or an agent's.
  let view = null, personAt = 0, agentAt = 0;
  let agentBox = null; // { x, y, w, h, t }: what the agent acts on now, in document pixels
  let agentTargets = null; // { list: [{ x, y, w, h }], t }: everything a form fill will act on
  let agentPresses = []; // [{ x, y, w, h, until }]: what PairBrowse declared it is about to press (document pixels)
  // The field the agent acts on, outlined in its color (top page only): { x, y, w, h } in document
  // pixels while shown, and the outline's element in the cursor's shadow root.
  let outline = null, outlineEl = null;
  const looked = () => {
    const n = now();
    if (n - agentAt < 1500) return;
    const y = Math.round(scrollY / 4) * 4, h = Math.round(innerHeight);
    if (!view || view.y !== y || view.h !== h) view = { y, h, t: n };
  };
  for (const kind of ["keydown", "pointerdown", "touchstart"]) addEventListener(kind, (e) => { if (e.isTrusted) personAt = now(); }, opts);
  addEventListener("scroll", () => { if (outline) placeOutline(); if (now() - personAt < 1500) looked(); }, opts);
  // Where the person's pointer is, in document coordinates (a shared tab shows it in the other
  // browser's copy at the same place in the page, whatever its window size). Never what's under it.
  // An agent's own mouse moves (its click's move onto the target, a drag) are trusted events too:
  // while it acts (PRESS_WINDOW_MS after its cursor or a press was sent), a move near what it acts
  // on is the agent's, never the person's pointer. Taken as theirs, the other side drew a person's
  // filled pointer, in their name and color, on top of the agent's white cursor.
  let ptr = null;
  addEventListener("mousemove", (e) => {
    if (!e.isTrusted) return;
    const n = now();
    if (n - agentAt < PRESS_WINDOW_MS && !awayFromAgent(e)) return;
    // A move with no distance (the engine sends one under a resting mouse when a page loads, scrolls
    // or changes under it) is nobody's new move: the pointer keeps the time of the move that put it
    // there, and whose it is goes by that time (a joiner's move replayed here stays theirs, never
    // the person's here: the helper tells them apart by it). None yet in this page: nothing to show.
    if (e.movementX || e.movementY) ptr = { x: Math.round(e.pageX), y: Math.round(e.pageY), t: n };
    else if (ptr) ptr = { x: Math.round(e.pageX), y: Math.round(e.pageY), t: ptr.t };
    // Only a move that moves: the engine also sends one, with no distance, when a page loads or
    // scrolls under a resting pointer, and that isn't the person looking.
    if ((e.movementX || e.movementY) && (!view || n - view.t > 1000)) looked();
    if (n - lastMove > 500) { lastMove = n; record("move", ""); }
  }, opts);

