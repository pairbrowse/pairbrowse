  // Someone asks to join the session (shown on the host's tab in front only, when the browser has
  // the focus): a card above the bottom bar's right end (the bar keeps who's driving, the last
  // actions and Pause agents in place) shows "Sam wants to join · drive", Allow, Deny and ×, the
  // newest request, with "+N more" pointing to the side panel. Each goes by itself after JOIN_SHOWN_MS (not while the
  // pointer is on it); the request stays in the side panel.
  // It lives in the bar's closed shadow root, so the page's DOM doesn't change when it shows, and
  // a page can't read, click or fake it. Only a real click counts: trusted, from a pointer (not a
  // key), at least JOIN_ARM_MS after what it shows last changed, and while the browser reports it
  // fully visible (nothing over it, no opacity or filter: IntersectionObserver v2; the bar never
  // fades while it asks, and the badge moves above the card), so a page can't slip it under a click meant for
  // something else. The click is only recorded here; the helper reads it with the key, checks it
  // again (not during an agent's action, nor a joiner's or the live view's replayed input) and
  // answers the request the side panel's way (daemon/joinprompt.mjs). Its text comes as an
  // object, never through JSON.parse.
  const JOIN_SHOWN_MS = 10_000, JOIN_ARM_MS = 600, JOIN_KEEP = 5;
  let joinSeen = null, joinVisible = false, joinAt = 0, joinShown = "";
  // Answers given, for the helper (kind "join-answers"): a chain of object literals in this
  // closure, never an array a page could reach through Array.prototype; at most 5 kept. gone:
  // the ids whose time ran out (not dismissed), as one string.
  let answered = null, answeredCount = 0, gone = "", dismissed = "";
  const joins = new Map(); // id -> { timer, who, role }, oldest first
  function joinWire(shadow) {
    const jq = shadow.querySelector(".jq");
    const answer = (kind) => (e) => {
      const id = joinShown;
      if (!e.isTrusted || !(e.detail > 0) || !id || !joins.has(id)) return;
      if (now() - joinAt < JOIN_ARM_MS) return;
      if (!joinVisible) return joinHint(`covered: answer in the ${panelName()}`);
      if (answeredCount < 5) { answered = { t: now(), kind, what: id, next: answered }; answeredCount++; }
      for (const b of jq.querySelectorAll(".jb button")) b.disabled = true;
      joinHint(kind === "join-allow" ? "letting them in…" : "");
      // Not answered after a moment (the helper didn't take the click): back to the buttons.
      setTimeout(() => { if (joinShown === id && joins.has(id)) { for (const b of jq.querySelectorAll(".jb button")) b.disabled = false; joinHint(`didn't go through: use the ${panelName()}`); } }, 3000);
    };
    for (const b of jq.querySelectorAll(".jb button, .jb .x")) b.addEventListener("mousedown", (e) => e.preventDefault()); // never takes focus from the page
    jq.querySelector(".ok").addEventListener("click", answer("join-allow"));
    jq.querySelector(".no").addEventListener("click", answer("join-deny"));
    jq.querySelector(".x").addEventListener("click", (e) => { if (e.isTrusted && joinShown) { dismissed = `${dismissed},${joinShown}`.slice(-200); joinOff(joinShown); } });
    // Not while the pointer is on it: someone reaching for Allow doesn't see it vanish.
    jq.addEventListener("pointerenter", () => { for (const j of joins.values()) clearTimeout(j.timer); });
    jq.addEventListener("pointerleave", () => { if (!aps.size) for (const id of joins.keys()) joinLater(id, 3000); });
    joinSeen?.disconnect();
    joinSeen = null;
    joinVisible = false;
  }
  // Whether the join request is really on screen (not covered, not hidden): watched only while
  // one shows, since the watching itself costs the page a little on every frame.
  function joinWatch(on) {
    const jq = bar?.querySelector(".jq");
    if (!on || !jq) { joinSeen?.disconnect(); joinSeen = null; joinVisible = false; return; }
    if (joinSeen) return;
    try {
      joinSeen = new IntersectionObserver((entries) => {
        for (const en of entries) joinVisible = "isVisible" in en ? en.isVisible : en.isIntersecting;
      }, { trackVisibility: true, delay: 100 });
      joinSeen.observe(jq);
    } catch { joinVisible = true; }
  }
  function joinHint(text) { const h = bar?.querySelector(".jq .h"); if (h) h.textContent = text ? ` · ${text}` : ""; }
  // Not while an approval covers the card: a request isn't hidden before it was ever seen. Its
  // timer starts anew when the last approval goes (joinDraw).
  function joinLater(id, ms) {
    const j = joins.get(id);
    if (!j) return;
    clearTimeout(j.timer);
    if (aps.size) return;
    j.timer = setTimeout(() => { if (joins.has(id)) { gone = `${gone},${id}`.slice(-200); joinOff(id); } }, ms);
  }
  // The bar shows the newest approval (an agent waiting for the person's OK), else the newest
  // request, or none.
  function joinDraw() {
    if (!bar) return;
    const jq = bar.querySelector(".jq");
    const ids = [...joins.keys()];
    const apId = [...aps.keys()].at(-1) || "";
    const id = apId ? "" : ids.at(-1) || "";
    const any = !!(apId || id);
    bar.classList.toggle("asking", any);
    if (any) bar.classList.remove("away");
    jq.hidden = !any;
    jq.classList.toggle("ap", !!apId);
    jq.querySelector(".jb").hidden = !id;
    jq.querySelector(".ab").hidden = !apId;
    joinWatch(any);
    if (!any) placeBadge();
    if (id !== joinShown) {
      joinShown = id;
      joinAt = now(); // what a click lands on just changed: no click counts for a moment
      for (const b of jq.querySelectorAll(".jb button")) b.disabled = false;
      joinHint("");
    }
    if (apId !== apShown) {
      if (!apId) for (const jid of ids) joinLater(jid, JOIN_SHOWN_MS); // the requests show again: their time starts now
      apShown = apId;
      apAt = now(); // the same for an approval: armed anew whenever what it shows changes
      for (const b of jq.querySelectorAll(".ab button")) b.disabled = false;
      apHint("");
    }
    if (apId) { apFill(jq, apId); placeBadge(); return; }
    if (!id) return;
    const j = joins.get(id);
    jq.querySelector(".t b").textContent = j.who;
    jq.querySelector(".r").textContent = j.role;
    const more = ids.length - 1;
    const m = jq.querySelector(".m");
    m.hidden = !more;
    m.textContent = more ? `+${more} more in the ${panelName()}` : "";
    placeBadge();
  }
  function joinOff(id) {
    const j = joins.get(id);
    if (!j) return false;
    clearTimeout(j.timer);
    joins.delete(id);
    joinDraw();
    return true;
  }
  // r: { id, who, role }.
  function joinOn(r) {
    if (!/^https?:$/.test(location.protocol) || !r || typeof r !== "object") return false; // web pages only, like the bar
    const id = String(r.id || "");
    if (!/^r[0-9a-f]{6}$/.test(id)) return false;
    if (joins.has(id)) return true;
    const wasBar = !!barHost?.isConnected;
    ensureBar();
    if (!wasBar) { drawBar(); placeBadge(); }
    while (joins.size >= JOIN_KEEP) { const old = joins.keys().next().value; dismissed = `${dismissed},${old}`.slice(-200); joinOff(old); }
    joins.set(id, { timer: 0, who: String(r.who || "Someone").slice(0, 60), role: r.role === "approve" ? "drive and approve" : r.role === "drive" ? "drive" : "watch" });
    joinLater(id, JOIN_SHOWN_MS);
    joinDraw();
    return true;
  }
  // For the helper's tests: the request the bar shows and where its buttons are (geometry only).
  const joinState = () => {
    const jq = bar?.querySelector(".jq");
    if (!joinShown || !jq || jq.hidden || !barHost?.isConnected) return [];
    const at = (sel) => { const b = jq.querySelector(sel).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
    return [{ id: joinShown, who: joins.get(joinShown).who, more: joins.size - 1, visible: !!joinVisible, allow: at(".ok"), deny: at(".no"), close: at(".x") }];
  };

