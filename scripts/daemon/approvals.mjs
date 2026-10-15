// Approvals in the browser: a named final click (pay, delete, publish, send, submit; a named OK on
// a page's dialog) asked in the PairBrowse browser as well as where the agent's app asks.
//
// - Claude Code: its PermissionRequest hook (scripts/guard.mjs) sends one line on the private
//   socket and waits; the terminal asks at the same time. The browser's Allow or Deny answers the
//   hook; a yes in the terminal sends the call, which withdraws the card here (arrived); a no there
//   stops the hook, and its socket closing withdraws the card.
// - Codex and other apps (never a joiner's agent): the helper itself asks in the browser and waits
//   before the call takes its turn (serve.mjs); no answer means today's hand-off to the user.
//
// An ask shows only where someone can really answer it: the in-page card on the agent's own tab
// when that tab is in front (never while joiners or invite-link viewers are on the session, and taken down when one comes), or
// the browser's own page that lists approvals (approve; the right dock and the strip don't list
// them yet, so they don't count). In the PairBrowse build with its own pages (docked) that page
// is the window's approval card (a bubble over the page card, its own widget: never in a tab's
// capture), the one browser home of click approvals: while it is there the in-page card isn't
// drawn. The item names the tab's CDP target id (tab.target, "" when unknown) so the browser
// shows the card in that tab's window. With neither, nothing is kept and nothing waits. A Codex ask
// whose only card goes (×, the page went elsewhere, the tab closed) with no such page open is
// handed to the user at once rather than left waiting where nothing can answer it. The card's text is the rule's own reason (guard.mjs approvalAsk), masked
// like titles; its id is random (128 bits). An answer from the in-page card counts only when it was
// a person's own click (presence.byPerson) in that very tab, ARM_MS or more after it showed; the
// page script checks the same first (scripts/hud.js).
import { randomBytes } from "node:crypto";
import { approvalAsk, approvalKey, APPROVAL_TOOLS, APPROVAL_WAIT_MS, HOOK_MARK } from "../guard.mjs";
import { within } from "../util.mjs";

export const APPROVAL_ID = /^ap-[0-9a-f]{32}$/;
export const ANSWERS = new Set(["allow", "deny", "terminal", "site"]);
export const ARM_MS = 600;
export const POLL_MS = 300;
const LINE_MAX = 64 * 1024;
const PAGE_KINDS = { "approval-allow": "allow", "approval-deny": "deny", "approval-terminal": "terminal" };
const SURFACES = ["approve"];
const EARLY_MS = 10_000; // a call that arrived before its hook's line: that ask is no longer real
const DEFAULT_COLOR = "#e9763f";
const UNKNOWN_COLOR = "#8699b1"; // no agent's spark color (the muted ink)

// The private socket carries two kinds of connection: an MCP client's (an agent) and a hook's
// single line (HOOK_MARK first). Reads until it can tell, then hands the socket on with what it read
// put back. A connection that never sends anything calls neither.
// Where an ask was made: its tab and that tab's origin then. An Allow holds only for the same tab
// still on the same origin: a navigation or another tab between the ask and the click (another
// agent, a joiner, the page itself) makes it a different click, asked again. here: { page, url }
// where the click would land now. Pure.
export const originOf = (url) => { try { const u = new URL(String(url)); return u.origin === "null" ? `${u.protocol}${u.pathname}` : u.origin; } catch { return ""; } };
export function sameWhere(where, here) {
  if (!where) return true; // asked with no tab of its own known: nothing to hold it to
  if (!here?.page || here.page !== where.page || here.page.isClosed?.()) return false;
  return !!where.origin && originOf(here.url ?? here.page.url?.()) === where.origin;
}

export function routeConnection(sock, { onHook, onOther }) {
  const mark = Buffer.from(HOOK_MARK);
  let buf = Buffer.alloc(0);
  let hook = false;
  const stop = () => sock.off("data", onData);
  const other = () => {
    stop();
    sock.pause();
    sock.unshift(buf);
    onOther(sock);
  };
  function onData(d) {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    if (buf.length > LINE_MAX) { stop(); sock.destroy(); return; }
    if (!hook) {
      const n = Math.min(buf.length, mark.length);
      if (!buf.subarray(0, n).equals(mark.subarray(0, n))) return other();
      if (buf.length < mark.length) {
        if (buf.includes(10)) return other();
        return; // still could be either
      }
      hook = true;
    }
    const nl = buf.indexOf(10);
    if (nl < 0) return;
    stop();
    onHook(sock, buf.subarray(0, nl).toString("utf8"));
  }
  sock.on("data", onData);
  sock.on("error", () => {});
}

// deps: hud (call, sparkColor, sparkPage), presence (byPerson), collaboration (its participants
// Map, for labels), liveView() (the live view or null: sharing, guestViewers, pageClients,
// tabIndex), frontPage() (the tab in front, or null), docked() (the browser has its own pages:
// its approve page is the window's approval card), targetOf(page, ms) (the tab's CDP target id or
// null; capture.mjs targetIdOf), mask(text), log(text).
export function createClickApprovals({ hud, presence, collaboration, liveView = () => null, frontPage = async () => null, docked = () => false, targetOf = async () => null, mask = (t) => t, log = () => {},
  now = Date.now, waitMs = APPROVAL_WAIT_MS, random = randomBytes, setInterval: every = setInterval, clearInterval: stopEvery = clearInterval }) {
  const items = new Map(); // id -> item
  const answered = new Map(); // key -> { answer, at }
  const early = new Map(); // key -> when the call arrived with nothing asked yet
  const participants = new Map(); // id -> { client, remote, tab }
  const listeners = new Set();
  let poll = null;
  let reading = false;
  let movedFrom = null; // the last Allow refused as "moved": where it was asked (lastWhere)

  const emit = (change) => { for (const fn of listeners) { try { fn(change); } catch {} } };
  const publicItem = (it) => ({ id: it.id, agent: { label: it.agent.label, color: it.agent.color }, kind: it.kind, target: it.target, reason: it.reason, tab: { id: it.tab.id, host: it.tab.host, target: it.tab.target }, at: it.at });
  const short = (id) => String(id).slice(0, 11);
  const remember = (key, answer, where = null) => {
    const t = now();
    for (const [k, r] of answered) if (t - r.at >= waitMs) answered.delete(k);
    answered.set(key, { answer, at: t, where });
  };

  function participant(id, info = {}) {
    participants.set(id, { client: String(info.client || ""), remote: !!info.remote, parent: Number.isSafeInteger(info.parent) ? info.parent : 0, tab: typeof info.tab === "function" ? info.tab : () => null });
  }
  function gone(id) {
    participants.delete(id);
    for (const it of [...items.values()]) if (it.participant === id) withdraw(it.id, "gone");
  }
  // The one agent of this app here (not a joiner's), or null when there are none or several.
  function only(client) {
    const found = [...participants.entries()].filter(([, p]) => !p.remote && p.client === client);
    return found.length === 1 ? found[0][0] : null;
  }
  // The agent a hook asks for: the one whose bridge the same app process started (its parent is
  // among the hook's ancestors, nearest first: an app run inside another's terminal is the inner
  // one), else the one agent of that app, else null. ancestors: process ids, the hook's parent first.
  function whose(client, ancestors) {
    const chain = Array.isArray(ancestors) ? ancestors.filter((n) => Number.isSafeInteger(n) && n > 1).slice(0, 8) : [];
    for (const pid of chain) {
      const found = [...participants.entries()].filter(([, p]) => !p.remote && p.client === client && p.parent === pid);
      if (found.length === 1) return found[0][0];
      if (found.length > 1) break;
    }
    return only(client);
  }

  // Ends an item: resolves its answer, takes the card down, tells the streams.
  function end(it, result) {
    if (!items.has(it.id)) return false;
    items.delete(it.id);
    clearTimeout(it.timer);
    const page = it.page;
    it.page = null;
    if (page && !page.isClosed?.()) within(2000, hud.call(page, it.id, "approval-off").catch(() => {})).catch(() => {});
    emit({ op: "withdraw", item: { id: it.id } });
    it.resolve(result);
    watch();
    return true;
  }

  async function open({ tool, input, ask, participant: p = null, client = "" }) {
    const key = approvalKey(tool, input);
    answered.delete(key); // a new ask for the same call: an earlier answer no longer holds
    const info = p ? participants.get(p) : null;
    // Asked by an agent it can't tell (several Claude Code agents here: the hook names none): said
    // so, in no agent's color, never as if it were one of them.
    const several = !info && client === "claude-code" && [...participants.values()].filter((x) => !x.remote && x.client === "claude-code").length > 1;
    const agent = info
      ? { label: String(collaboration?.participants?.get?.(p)?.label || "Agent"), color: hud.sparkColor?.(p) || DEFAULT_COLOR }
      : several ? { label: "One of the Claude Code agents", color: UNKNOWN_COLOR } : { label: "Claude Code", color: DEFAULT_COLOR };
    // The agent's own tab only: never a guess at another agent's.
    let page = info ? (info.tab() || hud.sparkPage?.(p) || null) : null;
    if (page?.isClosed?.()) page = null;
    const lv = liveView();
    let tab = { id: -1, host: "", target: "" };
    if (page) {
      let host = "";
      try { host = new URL(page.url()).host; } catch {}
      const index = lv?.tabIndex ? await within(2000, Promise.resolve(lv.tabIndex(page)).catch(() => -1)) : -1;
      // The tab's CDP target id: which window shows the browser's approval card.
      // Only the native build's card uses it: plain Chromium never waits on the lookup.
      const found = docked() ? await within(2000, Promise.resolve().then(() => targetOf(page, 2000)).catch(() => null)) : null;
      const target = typeof found === "string" && /^[0-9A-Za-z]{1,64}$/.test(found) ? found : "";
      tab = { id: Number.isInteger(index) ? index : -1, host, target };
    }
    const target = String(mask(String(ask?.target || ""))).slice(0, 120);
    const reason = String(mask(String(ask?.reason || ""))).slice(0, 300);
    const id = `ap-${random(16).toString("hex")}`;
    const at = now();
    // The in-page card: on the agent's tab in front, with nobody else looking, and only where the
    // browser has no approval card of its own (docked with its approve page there: that is the home).
    let shownIn = null;
    const bubble = !!docked() && surface();
    if (page && !bubble && !lv?.sharing?.() && !lv?.guestViewers?.()) {
      const front = await within(3000, Promise.resolve(frontPage()).catch(() => null));
      if (front === page) {
        // terminal: whether the agent's app asks too (Claude Code's terminal); elsewhere the third
        // button hands the step to the person.
        const ok = await within(2000, hud.call(page, { id, who: agent.label, color: agent.color, target, reason, terminal: client === "claude-code" }, "approval").catch(() => false));
        if (ok === true) shownIn = page;
      }
    }
    if (!shownIn && !surface()) return { shown: false };
    let resolve;
    const answer = new Promise((r) => { resolve = r; });
    // The tab and its origin as asked: an Allow holds only there (sameWhere).
    let origin = "";
    try { origin = page ? originOf(page.url()) : ""; } catch {}
    const where = page ? { page, origin } : null;
    const it = { id, key, client, participant: p, agent, kind: "click", target, reason, tab, at, resolve, timer: null, page: shownIn, shownAt: shownIn ? now() : 0, where };
    items.set(id, it);
    it.timer = setTimeout(() => { if (end(it, "expired")) log(`approval ${short(id)}: no answer in ${Math.round(waitMs / 1000)} s`); }, waitMs);
    it.timer.unref?.();
    emit({ op: "add", item: publicItem(it) });
    log(`approval ${short(id)}: asked in the browser for ${client || "an app"} (${shownIn ? "in the page" : bubble ? "in the browser's approval card" : "in the browser's pages"})`);
    watch();
    return { item: publicItem(it), shown: true, answer, where };
  }

  function answer(id, a, from) {
    const it = items.get(String(id));
    if (!it || !ANSWERS.has(a)) return false;
    remember(it.key, a === "site" ? "allow" : a, it.where);
    end(it, a);
    log(`approval ${short(id)}: ${a} from ${from}${a === "site" ? " (no per-site memory exists: treated as Allow)" : ""}`);
    return true;
  }

  function withdraw(id, why) {
    const it = items.get(String(id));
    if (!it) return false;
    end(it, "withdrawn");
    log(`approval ${short(id)}: withdrawn (${why})`);
    return true;
  }

  // A browser page that lists approvals is open.
  function surface() {
    const counts = liveView()?.pageClients?.() || {};
    return SURFACES.some((k) => Number(counts[k]) > 0);
  }

  // The call itself arrived (Claude Code: the terminal's yes, or the browser's Allow passed on).
  // here: where the click would land now ({ page, url }). "moved": the browser's Allow was for
  // this call in another tab or on another origin: refused, to be asked again.
  function arrived(tool, input, here = null) {
    const key = approvalKey(tool, input);
    for (const it of items.values()) if (it.key === key) { withdraw(it.id, "answered in the terminal"); return "withdrawn"; }
    const r = answered.get(key);
    if (!r) {
      // Before any ask: the terminal's yes beat the hook's line here. Remembered briefly, so that
      // line doesn't open a card for a click that already ran.
      const t = now();
      for (const [k, at] of early) if (t - at >= EARLY_MS) early.delete(k);
      early.set(key, t);
      return null;
    }
    answered.delete(key);
    if (r.answer === "allow" && !sameWhere(r.where, here)) { movedFrom = r.where; return "moved"; }
    // A browser Deny refuses the same call only within the race window (the call beat the hook's
    // answer); later, the terminal's own answer stands.
    return r.answer === "deny" && now() - r.at < EARLY_MS ? "denied" : null;
  }

  // The in-page cards' answers, read while one is shown (and only then).
  function watch() {
    const any = [...items.values()].some((it) => it.page);
    if (any && !poll) { poll = every(read, POLL_MS); poll?.unref?.(); }
    if (!any && poll) { stopEvery(poll); poll = null; }
  }
  // An item's card is gone from its page. Claude Code's terminal still asks; for another app,
  // with no browser page listing approvals either, nothing is left that can answer: the step is
  // handed to the user now rather than at the expiry.
  function lost(it) {
    it.page = null;
    if (it.client === "claude-code" || surface()) return;
    if (end(it, "terminal")) log(`approval ${short(it.id)}: no place left to ask: handed to the user`);
  }
  // Someone else came to look (a joiner let in, an invite link opened) while a card is shown:
  // every card comes down at once, so nothing of an approval reaches their frames. Claude Code's
  // asks stay pending for the terminal; another app's go to the browser's own page or to the user
  // (lost). Called by the live view and the daemon the moment one comes (cover), and by each tick
  // as the backstop.
  function cover() {
    for (const it of [...items.values()]) {
      if (!it.page) continue;
      const p = it.page;
      if (!p.isClosed?.()) within(2000, Promise.resolve(hud.call(p, it.id, "approval-off")).catch(() => {})).catch(() => {});
      lost(it);
      log(`approval ${short(it.id)}: card taken down (someone else is looking at the session)`);
    }
    watch();
  }
  async function read() {
    if (reading) return;
    reading = true;
    try {
      const lv = liveView();
      if (lv?.sharing?.() || lv?.guestViewers?.()) return cover();
      const pages = new Set([...items.values()].map((it) => it.page).filter(Boolean));
      // Each page with a card is read every tick, as the join card is: a card on a tab behind
      // can't be clicked anyway (hud.js requires the card fully visible), so its answers are empty.
      for (const page of pages) {
        if (page.isClosed?.()) { for (const it of [...items.values()]) if (it.page === page) lost(it); continue; }
        const got = await within(2000, Promise.resolve(hud.call(page, "", "approval-answers")).catch(() => null));
        if (!got || typeof got !== "object") continue; // a page loading: asked again next time
        let a = got.a;
        for (let n = 0; a && typeof a === "object" && n < 5; n++, a = a.next) pageAnswer(a.kind, a.what, page, Number(a.t));
        // Gone from the page (dismissed with ×, or the page went elsewhere): the ask stays pending
        // for the terminal and the browser's own page; this card isn't shown again (lost).
        const open = typeof got.ids === "string" ? new Set(got.ids.split(",").filter(Boolean)) : null;
        const dismissed = new Set(String(got.dismissed || "").split(",").filter(Boolean));
        for (const it of [...items.values()]) if (it.page === page && ((open && !open.has(it.id)) || dismissed.has(it.id))) lost(it);
      }
    } finally {
      reading = false;
      watch();
    }
  }
  function pageAnswer(kind, id, page, t) {
    const a = PAGE_KINDS[kind];
    if (!a) return false;
    const at = now();
    t = Math.min(at, Number.isFinite(t) ? t : at); // a time from the page is never later than now
    const it = items.get(String(id));
    const refused = !it ? "not waiting" : it.page !== page ? "another tab" : t < it.shownAt + ARM_MS ? "too soon after it showed"
      : !presence.byPerson(t) ? "not a person's own click (an agent or replayed input then)" : "";
    if (refused) { log(`approval ${short(id)}: a click on the card didn't count (${refused})`); return false; }
    return answer(it.id, a, "the page");
  }

  // A PermissionRequest hook's line (guard.mjs): ask, wait, answer one line.
  async function hook(sock, line) {
    sock.on("error", () => {});
    sock.resume(); // nothing more is read, but its end (the hook stopped) must be seen
    const say = (a) => { if (!sock.destroyed) sock.end(`${JSON.stringify({ answer: a })}\n`); };
    let msg = null;
    try { msg = JSON.parse(line); } catch {}
    const tool = msg?.tool;
    const input = msg?.input;
    if (!msg || msg.op !== "approval" || msg.v !== 1 || !APPROVAL_TOOLS.has(tool) || !input || typeof input !== "object" || Array.isArray(input)) return say("none");
    // The reason is the rule's own, worked out here: never what the line says.
    const ask = approvalAsk(tool, input);
    if (!ask) return say("none");
    const key = approvalKey(tool, input);
    const ran = early.get(key);
    early.delete(key);
    if (ran !== undefined && now() - ran < EARLY_MS) return say("none"); // answered in the terminal already
    const r = await open({ tool, input, ask, participant: whose("claude-code", msg.ancestors), client: "claude-code" });
    if (!r.shown) return say("none");
    const id = r.item.id;
    const stopped = () => withdraw(id, "the hook stopped: the terminal answered, or Claude Code stopped waiting");
    if (sock.destroyed) stopped();
    else sock.once("close", stopped);
    const a = await r.answer;
    say(a);
  }

  return {
    participant, gone, only, whose, open, answer, withdraw, arrived, hook, cover,
    lastWhere: () => (movedFrom ? { origin: movedFrom.origin } : null),
    pending: () => [...items.values()].map(publicItem),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
