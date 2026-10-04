// You, in the browser: your own clicks, typing and scrolling in the PairBrowse window (or the live
// view). People and agents work side by side: only an agent's next action that would change the
// page (going elsewhere, a link, a submit, Enter) waits while a person is at it in that tab; the
// fields a person fills are theirs (daemon/fields.mjs). Moving the pointer pauses nothing. An
// agent is told afterwards what people did: which button or field, never what they typed.
import { sleep, within } from "../util.mjs";
import { cleanName } from "../join.mjs";

const USER_IDLE_MS = 2000; // a person counts as busy in a tab until this long after their last input
const PERSON_SHOWN_MS = USER_IDLE_MS + 3000; // the tab overview keeps showing them a little longer
const USER_WAIT_MS = 10 * 60_000; // an agent gives up waiting for a person after this
const POLL_MS = 500;
const READ_LATE_MS = 3000; // input read later than this counts as this long ago
const USER_KINDS = new Set(["click", "type", "key", "wheel", "move", "went"]);

// host: the host's name. readEvents(frame): the page script's recorded input in that frame.
// pages(): the open tabs. paused(): true while no tab should be read (a session switch).
// onUsed(page): a tab used by hand (the tab cap's "used"). onStale(): refs may be stale now.
// applyBar(page), refreshTabs(): show who is waiting where. onPauseButton(kind): a person pressed
// "Pause agents" or "Resume" in the page's bar ("pause" or "resume"; never page input).
export function createPresence({ host, readEvents, pages, paused, onUsed, onStale, applyBar, refreshTabs, onPauseButton = () => {} }) {
  const humanAt = new WeakMap(); // tab -> { t, who }: the last time a person used it, and who
  const actedAt = new WeakMap(); // tab -> { t, who }: the same, without pointer moves
  const filled = new WeakMap(); // tab -> Map field name -> who filled it, for the agent's next result
  const userLogs = new WeakMap(); // tab -> what they did there, for the agent's next result
  const waitingIn = new Map(); // tab -> the person an agent waits for there (the bottom bar says so)
  const loadedAt = new WeakMap(); // when each tab's page last finished loading
  const lastUrls = new WeakMap();
  const busy = []; // when agents' actions ran: input in those moments is theirs
  // What people did in each tab, numbered, for a browser that shares it (a joined session):
  // local is this browser's own person; the others came from the other browser.
  const feeds = new WeakMap(); // tab -> [{ n, who, line, local }]
  let feedSeq = 0;
  const toFeed = (page, who, line, local) => {
    const feed = feeds.get(page) || [];
    feeds.set(page, feed);
    feed.push({ n: ++feedSeq, who, line, local });
    if (feed.length > 20) feed.shift();
  };

  const personIn = (page) => { const h = page && humanAt.get(page); return h && Date.now() - h.t < USER_IDLE_MS ? h.who : null; };
  // Someone clicking, typing or scrolling in this tab just now (pointer moves don't count).
  const actingIn = (page) => { const h = page && actedAt.get(page); return h && Date.now() - h.t < USER_IDLE_MS ? h.who : null; };
  function actedIn(page, who, t = Date.now()) {
    if (!page) return;
    const prev = actedAt.get(page);
    if (!prev || t >= prev.t) actedAt.set(page, { t, who });
  }
  function filledIn(page, who, name) {
    if (!page || !name) return;
    const m = filled.get(page) || new Map();
    filled.set(page, m);
    m.delete(name);
    m.set(name, who);
    if (m.size > 12) m.delete(m.keys().next().value);
  }
  const recentPerson = (page) => { const h = humanAt.get(page); return h && Date.now() - h.t < PERSON_SHOWN_MS ? h.who : null; };
  function humanIn(page, who = host, t = Date.now()) {
    if (!page) return;
    const prev = humanAt.get(page);
    const newer = t >= (prev?.t || 0);
    humanAt.set(page, { t: Math.max(t, prev?.t || 0), who: newer ? who : prev.who, ...(!newer && prev.remote ? { remote: true } : {}) });
    refreshTabs();
  }

  // Marks an agent's action as running; call the returned function when it's done. tag "popup":
  // PairBrowse closing a late popup (it clicks, but never types in a field).
  function busyStart(tag = "") {
    const span = [Date.now() - 50, Infinity];
    span.tag = tag;
    busy.push(span);
    if (busy.length > 50) busy.shift();
    return () => { span[1] = Date.now() + 700; };
  }
  const byAgent = (t, after = 0) => busy.some(([start, end]) => t >= start && t <= end + after);
  const agentActing = () => busy.some(([, end]) => end === Infinity);

  // Entries come from the page, so each one is checked: a known kind, a short label, and a time
  // no later than now (a page could otherwise hold agents back with times in the future). Whose
  // input it was is judged by when it happened, even when it's read late (a busy computer); only
  // the time recorded for the person is kept recent.
  function userDid(events, page = null) {
    const at = Date.now();
    // The bar's own button: a person's (never during an agent's action), and not page input.
    for (const e of (Array.isArray(events) ? events : []).slice(0, 60)) {
      if ((e?.kind === "pause" || e?.kind === "resume") && !byAgent(Math.min(at, Number(e.t) || at))) onPauseButton(e.kind);
      // A person in the other browser filled this field (set here by the helper itself).
      if (e?.kind === "filled" && page) filledIn(page, cleanName(e.who, "Someone"), String(e.what ?? "").replace(/[\u0000-\u001f\u007f"`<>]/g, "").trim().slice(0, 60));
    }
    const clean = (Array.isArray(events) ? events : []).slice(0, 60).filter((e) => e && USER_KINDS.has(e.kind)).map((e) => {
      const happened = Math.min(at, Number(e.t) || at);
      return {
        kind: e.kind,
        happened,
        t: Math.max(at - READ_LATE_MS, happened),
        what: String(e.what ?? "").replace(/[\u0000-\u001f\u007f"`<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60),
      };
    });
    const yours = clean.filter((e) => e.kind === "wheel" || !byAgent(e.happened));
    if (!yours.length) return;
    humanIn(page, host, Math.min(at, Math.max(...yours.map((e) => e.t))));
    const acts = yours.filter((e) => e.kind !== "move");
    if (acts.length) actedIn(page, host, Math.min(at, Math.max(...acts.map((e) => e.t))));
    if (!page) return;
    const userLog = userLogs.get(page) || [];
    userLogs.set(page, userLog);
    for (const e of yours) {
      if (e.kind === "move") continue;
      if (e.kind === "type") filledIn(page, host, e.what);
      const line = e.kind === "click" ? `clicked ${e.what ? `"${e.what}"` : "on the page"}` : e.kind === "type" ? `typed in ${e.what ? `"${e.what}"` : "a field"}` :
        e.kind === "key" ? `pressed ${e.what}` : e.kind === "went" ? `went to ${e.what}` : "scrolled";
      if (userLog.at(-1) !== line) { userLog.push(line); toFeed(page, host, line, true); }
    }
    if (userLog.length > 20) userLog.splice(0, userLog.length - 20);
    if (yours.some((e) => !["move", "wheel"].includes(e.kind))) onStale();
  }

  // Reads every tab, and its first frames (card and code fields often live in one).
  let polling = false;
  setInterval(async () => {
    if (paused() || polling) return;
    polling = true;
    try {
      const frames = (await pages()).flatMap((p) => p.isClosed() ? [] : p.frames().slice(0, 8).map((f) => [p, f]));
      const all = await Promise.all(frames.map(([, f]) => within(1000, readEvents(f).catch(() => null))));
      all.forEach((events, i) => {
        if (!Array.isArray(events) || !events.length) return;
        if (events.some((e) => e?.kind !== "move")) onUsed(frames[i][0]);
        userDid(events, frames[i][0]);
      });
    } finally {
      polling = false;
    }
  }, POLL_MS).unref();

  // A page you opened yourself (address bar, a link): a new document loading while no agent was
  // acting, or for a while after (a click's page can finish loading late).
  function watchUser(page) {
    lastUrls.set(page, page.url());
    page.on("load", () => {
      loadedAt.set(page, Date.now());
      const url = page.url();
      const before = lastUrls.get(page);
      lastUrls.set(page, url);
      // A new address only: news sites and dashboards reload themselves in background tabs.
      if (url !== before && !byAgent(Date.now(), 5000) && /^https?:/.test(url)) userDid([{ t: Date.now(), kind: "went", what: url.slice(0, 120) }], page);
    });
  }

  // Waits until nobody has clicked, typed or scrolled in this tab for USER_IDLE_MS (at most
  // USER_WAIT_MS). Only for an agent's action that would change the page under them.
  async function waitForUser(page) {
    if (!actingIn(page)) return;
    waitingIn.set(page, actingIn(page));
    applyBar(page);
    refreshTabs();
    const giveUp = Date.now() + USER_WAIT_MS;
    try {
      while (actingIn(page) && Date.now() < giveUp) {
        waitingIn.set(page, actingIn(page));
        await sleep(250);
      }
    } finally {
      waitingIn.delete(page);
      if (!page.isClosed()) applyBar(page);
      refreshTabs();
    }
  }

  // A person in the other browser of a joined session used their copy of this tab: the same as
  // someone here (agents in this tab wait, then hear what they did). lines: field and button
  // names only, never values (the other side's presence made them).
  // acting: they clicked, typed or scrolled there just now (not only moved the pointer).
  function elsewhere(page, who, lines = [], acting = false) {
    if (!page) return;
    // Only there (moving the pointer, say): nothing waits, but agents are told someone was.
    const acted = lines.length > 0;
    if (!acted && personIn(page) !== who) lines = ["was in this tab"];
    humanIn(page, who);
    if (acted || acting) actedIn(page, who);
    if (acted) onUsed(page); // in use on the other side too: the tab cap keeps it
    const h = humanAt.get(page);
    if (h.who === who) h.remote = true; // never sent back to where it came from
    const userLog = userLogs.get(page) || [];
    userLogs.set(page, userLog);
    for (const raw of lines.slice(0, 10)) {
      const line = String(raw ?? "").replace(/[\u0000-\u001f\u007f`<>]/g, "").slice(0, 80);
      if (line && userLog.at(-1) !== line) { userLog.push(line); toFeed(page, who, line, false); }
      const field = line.match(/^typed in "(.+)"$/)?.[1];
      if (field) filledIn(page, who, field);
    }
    if (userLog.length > 20) userLog.splice(0, userLog.length - 20);
    if (acted) onStale();
  }
  // Who is using this tab by hand right now ({ who, local }), and what people did there after n.
  const sharedPerson = (page) => { const h = page && humanAt.get(page); return h && Date.now() - h.t < USER_IDLE_MS ? { who: h.who, local: !h.remote, acting: !!actingIn(page) } : null; };
  const feedAfter = (page, n = 0) => (feeds.get(page) || []).filter((e) => e.n > n);

  // What the person did in the tab, as a note for the agent's next result (once).
  // Also the fields people filled (names, never values): theirs, so agents leave them be.
  function userNote(page) {
    const userLog = page && userLogs.get(page);
    const fields = page && filled.get(page);
    const out = [];
    if (userLog?.length) {
      const who = humanAt.get(page)?.who || host;
      out.push(`- ${who === host ? "The user" : who} used this tab meanwhile: ${userLog.splice(0).join(", ")}. Look at the page again (browser_snapshot) before you go on.`);
    }
    if (fields?.size) {
      out.push(`- Fields people filled: ${[...fields].map(([name, who]) => `"${name}" (${who === host ? "the user" : who})`).join(", ")}. Leave them as they wrote them.`);
      fields.clear();
    }
    return out.join("\n");
  }
  const didIn = (page) => (userLogs.get(page) || []).join(", ");

  return {
    // Whether something at time t happened during an agent's action (its own pointer moves).
    byAgent: (t) => byAgent(t),
    // Whether time t fell in an agent's own tool call (typing in fields happens only there).
    typedByAgent: (t) => busy.some((s) => s.tag !== "popup" && t >= s[0] && t <= s[1]),
    personIn, actingIn, recentPerson, humanIn, elsewhere, sharedPerson, feedAfter, busyStart, agentActing, userDid, watchUser, waitForUser, userNote, didIn,
    waiting: (page) => waitingIn.get(page), loadedAt: (page) => loadedAt.get(page) || 0,
  };
}
