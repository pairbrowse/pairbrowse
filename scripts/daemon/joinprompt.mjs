// A join request, as the host hears of it, beside the side panel's Allow / Deny (which always
// lists it). One alert at a time:
// - The browser window has the focus (the person is looking at it) and its tab in front is a web
//   page: the bottom bar there asks, "Sam (Claude Code) wants to join (drive) · Allow · Deny · ×"
//   (scripts/hud.js draws it). It goes by itself after a while; the request stays pending.
// - Otherwise (another app in front, the window minimized, no web page in front): a notification
//   with Allow and Deny (daemon/panel.mjs notifyJoin), once per request; the bar asks when the
//   person comes back to the browser while the request still waits. A request whose time in the
//   bar ran out while the window wasn't focused asks there again then too.
// Either comes down wherever the request is answered (the side panel, the live view, an agent's
// approve the user confirmed, a revoke).
//
// An answer from it counts only when it was a person's own click (byPerson: no agent acting then,
// no joiner's or live view's input being replayed), in the very tab it was shown in, for a request
// still waiting, ARM_MS or more after it showed. Then it's answered the way the side panel's
// buttons answer it (approvals.approve / deny).

export const ARM_MS = 600;
const POLL_MS = 300;
export const FOCUS_POLL_MS = 1000;
const KINDS = new Set(["join-allow", "join-deny"]);

// The one rule: a notification unless the bar asked in a window known to have the focus.
// focused: true, false, or null when the browser can't say (then both).
export const shouldNotify = ({ focused, shown }) => !(focused === true && shown === true);

// approvals: createApprovals (join.mjs). front(): the tab in front in the host's browser (a
// Playwright page), or null. focused(): whether the browser window has the system's focus (true,
// false, or null when unknown; see pbFocused in browser/panel/background.js). show(page, value,
// kind): one call into the page script (hud.call). byPerson(t): whether input at time t was a
// person's own (presence.mjs). notify({ who, role, request }), clear(request): a join request's
// notification, and taking it down (panel.mjs). log(text).
export function createJoinPrompt({ approvals, front, focused = async () => null, show, byPerson, notify = () => {}, clear = () => {}, log = () => {} }) {
  const shown = new Map(); // request id -> { page, at, away } (away: the window lost the focus meanwhile)
  const asked = new Set(); // request ids seen already
  const unseen = new Set(); // request ids waiting for the prompt to show in a focused window
  const alerted = new Set(); // new requests to alert about (alert); restored ones are only listed
  const notified = new Set(); // request ids a notification went out for
  let chain = Promise.resolve();
  let poll = null, focusPoll = null;

  async function sync() {
    const pending = approvals.pending();
    const waiting = new Set(pending.map((r) => r.id));
    // Answered or gone (anywhere): down from the page it's on.
    for (const [id, s] of shown) {
      if (waiting.has(id)) continue;
      shown.delete(id);
      if (!s.page.isClosed()) await show(s.page, id, "join-off").catch(() => {});
    }
    for (const id of notified) if (!waiting.has(id)) clear(id);
    for (const set of [asked, unseen, notified, alerted]) for (const id of set) if (!waiting.has(id)) set.delete(id);
    for (const r of pending) if (!asked.has(r.id)) { asked.add(r.id); unseen.add(r.id); }
    const todo = pending.filter((r) => unseen.has(r.id) && !shown.has(r.id));
    const hasFocus = shown.size || todo.length ? await focused().catch(() => null) : null;
    if (hasFocus === false) for (const s of shown.values()) s.away = true;
    if (todo.length) {
      const page = hasFocus === false ? null : await front().catch(() => null);
      for (const r of todo) {
        const who = `${r.name || "Someone"}${r.app ? ` (${r.app})` : ""}`;
        const ok = !!page && !page.isClosed() && (await show(page, { id: r.id, who, role: r.role }, "join").catch(() => false)) === true;
        if (ok) { shown.set(r.id, { page, at: Date.now(), away: false }); unseen.delete(r.id); }
        if (shouldNotify({ focused: hasFocus, shown: ok })) send(r, who);
        else if (alerted.has(r.id) && !notified.has(r.id)) log(`join request ${r.id}: asked in the bar (the browser has the focus), no notification`);
        // Shown where the focus can't be told: as before, no waiting to show it again.
        if (ok || hasFocus === null) unseen.delete(r.id);
      }
    }
    watch();
  }
  function send(r, who) {
    if (notified.has(r.id) || !alerted.has(r.id)) return;
    notified.add(r.id);
    notify({ who, role: r.role, request: r.id });
  }
  const refresh = () => { chain = chain.then(sync).catch((e) => log(`join prompt: ${e?.message || e}`)); return chain; };
  approvals.onChange(refresh);

  // A new request (sharing.mjs onJoinRequest): alert the person, the bar or a notification.
  function alert(entry) {
    const id = String(entry?.id || "");
    if (!id || alerted.has(id)) return refresh();
    alerted.add(id);
    // Already looked at before this (the change came first): decide again now.
    if (asked.has(id) && !shown.has(id)) unseen.add(id);
    return refresh();
  }

  // While a prompt is up: its answers, read from the page it's in. While a request waits for a
  // focused window, or a prompt is up: the focus, read every FOCUS_POLL_MS.
  function watch() {
    if (shown.size && !poll) { poll = setInterval(read, POLL_MS); poll.unref?.(); }
    if (!shown.size && poll) { clearInterval(poll); poll = null; }
    if ((shown.size || unseen.size) && !focusPoll) { focusPoll = setInterval(refresh, FOCUS_POLL_MS); focusPoll.unref?.(); }
    if (!shown.size && !unseen.size && focusPoll) { clearInterval(focusPoll); focusPoll = null; }
  }
  let reading = false;
  async function read() {
    if (reading) return;
    reading = true;
    try {
      for (const page of new Set([...shown.values()].map((s) => s.page))) {
        if (page.isClosed()) { for (const [id, s] of shown) if (s.page === page) shown.delete(id); continue; }
        const got = await show(page, "", "join-answers").catch(() => null);
        if (!got || typeof got !== "object") continue; // a page loading: asked again next time
        let a = got.a;
        for (let n = 0; a && typeof a === "object" && n < 5; n++, a = a.next) answer(a.kind, a.what, page, Number(a.t));
        // Its time ran out: if the window wasn't focused meanwhile, it shows again once it is.
        const expired = new Set(String(got.gone || "").split(",").filter(Boolean));
        for (const id of expired) {
          const s = shown.get(id);
          if (s?.page !== page) continue;
          shown.delete(id);
          if (s.away || (await focused().catch(() => null)) === false) unseen.add(id);
        }
        // Gone from the page (dismissed, the page went elsewhere): nothing to read there.
        if (!got.open) for (const [id, s] of shown) if (s.page === page) shown.delete(id);
      }
    } finally {
      reading = false;
      watch();
    }
  }

  // An answer from the prompt in page, made at time t. Returns the request it answered, or null.
  function answer(kind, id, page, t) {
    const at = Date.now();
    t = Math.min(at, Number.isFinite(t) ? t : at); // a time from the page is never later than now
    const s = shown.get(String(id));
    if (!KINDS.has(kind) || !s || s.page !== page || t < s.at + ARM_MS || !byPerson(t)) return null;
    if (!approvals.pending().some((r) => r.id === id)) return null;
    const done = kind === "join-allow" ? approvals.approve(id) : approvals.deny(id);
    if (done) log(`join request ${id} ${kind === "join-allow" ? "allowed" : "denied"} in the page's prompt`);
    return done;
  }

  return { refresh, answer, alert, front, shown: () => [...shown.keys()], unseen: () => [...unseen] };
}
