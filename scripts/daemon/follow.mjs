// Joining someone's session (pairbrowse_join): this browser opens the host's tabs, as real tabs of
// its own, in a window of their own, and keeps following them. With a drive code, changes made
// here in those tabs (by the user or their agent) go back to the host's browser. Addresses, form
// values (sensitive ones only as filled), tab order, pointers and who does what cross
// (tabsync.mjs), never cookies or pictures; everyone stays signed in as themselves. What happens in the host's
// session shows here like local activity: in the bar at the bottom of each page, the side panel
// and the tab overview.
import { parseJoinCode, cleanName, displayName } from "../join.mjs";
import { startJoin } from "../relay.mjs";
import { createMirror, createFormSync, createOrderSync, sameOrder, readForm, readPointer, readView, formUrl, VIEW_FRESH_MS, onSecretDomain, shareableUrl, crossingText, turnLeft, tabWho, personColor, TABS_MAX, OPS_MAX } from "../tabsync.mjs";
import { keepFocus } from "../focus.mjs";
import { readDevEntry, DEV_COOKIE, DEV_PORTS_MAX } from "../devshare.mjs";
import { savedName, saveParticipantName, paths } from "../paths.mjs";
import { sleep, currentAccount, within } from "../util.mjs";
import { panelExtensionId } from "../browser.mjs";
import { pathsIn, withPaths } from "./serve.mjs";
import { uploadProblem } from "../upload.mjs";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// Runs tasks one at a time, in order; a failed task doesn't stop the next.
function serially() {
  let last = Promise.resolve();
  return (task) => { const run = last.then(task); last = run.catch(() => {}); return run; };
}

// The shared browser's picture page (screen.html, PairBrowse's own extension page) is called in its
// own script world, where its script put window.pbScreen: Patchright's page.evaluate otherwise runs
// in a hidden world of its own (the extra arguments are Patchright's; Playwright ignores them).
const inScreen = (page, fn, arg) => page.evaluate(fn, arg, undefined, false);
const OPEN_MS = 15_000;
const ADOPT_MS = 10_000; // a tab opened from a shared one has this long to get a web address (in the shared window: no limit)
const FIRST_ACTIVITY = 3; // on joining, the last few things that happened
const FORM_BYTES = 60_000; // form values read here in one round, before it's sent
const AGENT_AGAIN_MS = 10_000; // an agent here is said again this often (the other side forgets it)
const POINTER_FRESH_MS = 3000; // a pointer still for this long fades out
const POINTER_MS = 40; // pointers go out at most 25 times a second
const PERSON_AGAIN_MS = 500;
const LATE_NEWS_MS = 15_000; // what a person here did, still sent when a round comes this late
const FORMS_ALL_MS = 2000; // every field is read again this often, in case a change went unannounced
const ORDER_MS = 1000; // the tab order here is checked this often
const OUTBOUND_MS = 250; // this side's tab changes are looked for this often
const FORM_COALESCE_MS = 30; // keystrokes that come together go as one
// Shared browser mode (codes with mode "shared"): each of the host's tabs is a page of the
// extension here (screen.js) showing it live; the tab you look at is connected directly.
const SCREEN_KEEP_MS = 60_000; // a tab out of sight stays connected this long (switching back is instant)
const SCREEN_CONNECT_MS = process.env.PAIRBROWSE_TEST_NO_DIRECT === "1" ? 3000 : 12_000; // no direct connection by then: try again, then the slower route
const SCREEN_INPUT_MS = 30; // on the slower route, input goes to the host this often
const screenBase = () => `chrome-extension://${panelExtensionId()}/screen.html`;
// The tab id after # keeps the address short (screen.html#a1b2c3d4); the page itself shows the
// host tab's real address and title (screen.js).
const screenUrl = (id) => `${screenBase()}#${encodeURIComponent(id)}`;
const isScreen = (page) => page.url().startsWith(screenBase());
// The tools an agent here uses in the host's browser while in a shared browser session (the rest,
// such as its status, remembered details and sessions, stay here).
const FORWARDED = new Set(["pairbrowse_run", "pairbrowse_scroll", "pairbrowse_upload", "pairbrowse_click_at"]);
const AGENT_CALL_MS = 15 * 60_000; // a call there (a hand-off waits for a person) answers within this
const FILE_PART = 120_000; // bytes of a file per message to the host
// Logs how long pointers and field values took from the other side's page (for the live check).
const latencyLog = process.env.PAIRBROWSE_LATENCY_LOG === "1";

// context: the helper's browser ({ getContext }). hud: addActivity, onActivity. presence: people
// using tabs by hand (a person in the other browser's copy of a tab counts as one here).
// liveView(): the user's live view (who is in the session). secretDomains(): sites with this
// user's saved passwords. forms: { read(page), apply(page, fields, who) } (daemon/forms.mjs, as
// they may cross). tabOrder: daemon/taborder.mjs. localAgent(page): the agent here holding the
// tab ({ label, color }), or null.
// onSession(data, join), onMessage(data, join): who does what there, and messages from there.
// onLeft(): the session ended here (left, denied, ended): its pause no longer holds agents here.
export function createFollow({ config, log, context, hud, presence, liveView, secretDomains, forms, tabOrder, localAgent = () => null, onSession = null, onMessage = null, onLeft = null }) {
  let s = null; // { join, mirror, pages: Map id -> page, owner, window, windowId, lastT, candidates, seen, heard, told, agents, outbox }
  const idOf = (cur, page) => { for (const [id, p] of cur.pages) if (p === page) return id; return null; };

  // This browser's agents' activity in a shared tab goes to the other browser (drive), like its
  // address changes. What came from there is marked and never goes back.
  hud.onActivity((text, who, page, from) => {
    const cur = s;
    if (!cur || from || !page || cur.join.role !== "drive") return;
    const id = idOf(cur, page);
    if (id && cur.outbox.length < OPS_MAX) cur.outbox.push({ op: "activity", id, text: crossingText(text), who });
  });

  const pageId = async (ctx, page) => {
    const cdp = await ctx.newCDPSession(page);
    try { return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId; } finally { cdp.detach().catch(() => {}); }
  };
  // The browser window a tab is in.
  const windowOf = async (ctx, page) => {
    const cdp = await ctx.newCDPSession(page);
    try { return (await cdp.send("Browser.getWindowForTarget")).windowId; } finally { cdp.detach().catch(() => {}); }
  };

  // A new tab at url: the first one in a new window, the next ones next to it (the browser puts
  // a new tab in the window used last). Found by its target id, so another tab opening at the
  // same moment (an agent's) is never taken for it.
  async function openTab(url) {
    const ctx = await context.getContext();
    const before = new Set(ctx.pages());
    const any = ctx.pages().find((p) => !p.isClosed());
    try {
      if (!any) throw new Error("no tab to ask from");
      const cdp = await ctx.newCDPSession(any);
      let targetId;
      try { ({ targetId } = await cdp.send("Target.createTarget", { url, newWindow: !s.window, background: !!s.window })); } finally { cdp.detach().catch(() => {}); }
      const until = Date.now() + OPEN_MS;
      while (Date.now() < until) {
        for (const p of ctx.pages()) {
          if (before.has(p) || p.isClosed() || (await pageId(ctx, p).catch(() => "")) !== targetId) continue;
          if (!s.window) s.windowId = await windowOf(ctx, p).catch(() => null); // the shared window
          s.window = true;
          return p;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the new tab didn't show up");
    } catch (e) {
      log("shared tab", e?.message || e);
      const page = await keepFocus(() => ctx.newPage());
      await page.goto(url, { waitUntil: "commit", timeout: OPEN_MS }).catch(() => {});
      return page;
    }
  }

  async function closeTab(page) {
    const ctx = await context.getContext();
    if (ctx.pages().length > 1) await page.close().catch(() => {}); else await page.goto("about:blank").catch(() => {});
  }

  // What changed here goes there (drive): run a few times a second, and at once when a field
  // changed. A watcher's changes stay here (their fields are still read: values from there
  // never land on top of what the person here is typing).
  async function outbound(cur) {
    if (s !== cur || cur.join.phase !== "in") return;
    const drive = cur.join.role === "drive";
    const ctx = await context.getContext();
    const mine = { full: drive, secretDomains: secretDomains() };
    const ops = [];
    for (const [id, page] of cur.pages) {
      if (page.isClosed()) { cur.pages.delete(id); const op = cur.mirror.closedHere(id); if (drive && op) ops.push(op); continue; }
      const op = cur.mirror.fromLocal(id, shareableUrl(page.url(), mine));
      if (drive && op) ops.push(op);
      // A person here, using this copy by hand: agents there wait for them too (drive only).
      // What they did lately is sent even when this round comes late (a busy computer, a slow
      // round before it) and they are idle again by now: dropped, the host's agents would never
      // hear of a click.
      const person = presence.sharedPerson(page);
      const fresh = drive ? presence.feedAfter(page, cur.told.get(page) || 0).filter((e) => e.local && (person?.local || Date.now() - e.t < LATE_NEWS_MS)) : [];
      if (drive && (person?.local || fresh.length)) {
        if (fresh.length) cur.told.set(page, fresh.at(-1).n);
        // Still there: said again twice a second (the host's agents wait while it's fresh).
        if (fresh.length || Date.now() - (cur.personSent.get(id) || 0) >= PERSON_AGAIN_MS) {
          cur.personSent.set(id, Date.now());
          ops.push({ op: "person", id, did: fresh.map((e) => e.line), ...(person?.acting ? { acting: true } : {}) });
        }
      }
    }
    // Values typed here (sensitive ones only as filled), read at most every few hundred ms per
    // tab; and the agents here (drive). A watcher's stay here; reading them still keeps values
    // from there from landing on top of what the person here is typing.
    if (cur.shared) await screensRound(cur, (id, page) => {
      const op = drive ? cur.mirror.typed(id, shareableUrl(page.url(), mine)) : null;
      if (op) ops.push(op);
      log(`shared browser: an address typed in a picture tab (${new URL(page.url()).host}) ${op ? "goes to the host's tab" : "stays here (watch, the same address, or not shareable)"}`);
    });
    let formBytes = 0;
    const all = !cur.shared && Date.now() - cur.formsAllAt > FORMS_ALL_MS; // in case a change went unannounced
    if (all) cur.formsAllAt = Date.now();
    for (const [id, page] of cur.pages) {
      if (cur.shared || page.isClosed() || cur.quiet.has(id) || formBytes > FORM_BYTES || !(all || cur.dirty.has(page))) continue;
      cur.dirty.delete(page);
      const read = await forms.read(page).catch(() => null);
      if (!read) continue;
      const changed = cur.forms.local(id, read.url, read.fields);
      if (drive && changed.length) { const op = { op: "form", id, url: read.url, fields: changed }; formBytes += JSON.stringify(op).length; ops.push(op); }
    }
    if (drive) {
      for (const [id, page] of cur.pages) {
        if (page.isClosed() || cur.quiet.has(id)) continue;
        const a = localAgent(page);
        // Taking or ending a turn here goes at once: the host's agents wait for it.
        const sig = a ? `${a.label}\u0001${a.color}\u0001${a.until ? 1 : 0}` : "";
        const was = cur.agentSent.get(id);
        if ((was?.sig ?? "") === sig && !(sig && Date.now() - was.at > AGENT_AGAIN_MS)) continue;
        cur.agentSent.set(id, { sig, at: Date.now() });
        ops.push({ op: "agent", id, who: a?.label || "", color: a?.color || "", left: a?.until ? Math.max(0, a.until - Date.now()) : 0 });
      }
    }
    if (Date.now() - (cur.orderAt || 0) > ORDER_MS) await checkOrder(cur);
    await applyForms(cur); // values from there whose page has loaded here since
    ops.push(...cur.outbox.splice(0));
    // Tabs opened from a shared tab (a link to a new tab, a popup) are shared too, and so are new
    // tabs opened in the shared window (they wait there until they have a web address).
    const adopting = [];
    if (drive) {
      const mapped = new Set(cur.pages.values());
      for (const p of ctx.pages()) {
        if (mapped.has(p) || p.isClosed() || cur.seen.has(p)) continue;
        let since = cur.candidates.get(p);
        if (since === undefined) {
          const opener = await p.opener().catch(() => null);
          since = opener && mapped.has(opener) ? Date.now()
            : cur.windowId != null && (await windowOf(ctx, p).catch(() => null)) === cur.windowId ? Infinity : -1;
        }
        if (since < 0 || Date.now() - since > ADOPT_MS) { cur.seen.add(p); cur.candidates.delete(p); continue; }
        cur.candidates.set(p, since);
        const url = shareableUrl(p.url(), mine);
        if (!url || cur.pages.size + adopting.length >= TABS_MAX) continue;
        const op = cur.mirror.opening(url);
        ops.push(op);
        adopting.push({ op, page: p });
        cur.seen.add(p);
        cur.candidates.delete(p);
      }
    }
    if (ops.length) {
      let answer = null;
      for (let i = 0; i < ops.length; i += OPS_MAX) {
        const r = await cur.join.send(ops.slice(i, i + OPS_MAX));
        if (r) answer = { ...r, opened: { ...answer?.opened, ...r.opened } };
      }
      for (const { op, page } of adopting) {
        const id = answer?.opened?.[op.ref];
        if (!id || !cur.mirror.opened(id, op.url)) continue;
        cur.pages.set(id, page);
        // Shared browser: the tab opened there; here it becomes its picture.
        if (cur.shared) await page.goto(screenUrl(id), { waitUntil: "commit", timeout: OPEN_MS }).catch(() => {});
      }
    }
  }

  // A move made here goes there (drive); else the host's order applies here.
  async function checkOrder(cur) {
    cur.orderAt = Date.now();
    const live = [...cur.pages].filter(([, p]) => !p.isClosed());
    if (live.length < 2) return;
    const sorted = await tabOrder.order(live.map(([, p]) => p)).catch(() => null);
    if (!sorted || s !== cur) return;
    const ids = sorted.map((p) => idOf(cur, p));
    const r = cur.order.fromLocal(ids);
    if (r.send && cur.join.role === "drive") cur.outbox.push(r.send);
    if (r.arrange && !sameOrder(ids, r.arrange) && await tabOrder.arrange(r.arrange.map((id) => cur.pages.get(id))).catch(() => false)) cur.order.arranged(r.arrange);
  }

  // Dev servers the host shares (devshare.mjs): this joiner's key for each, as a cookie for that
  // address only (HttpOnly: pages can't read it), before the tabs on them open. Checked here too:
  // Quick Tunnel addresses only.
  async function allowDevServers(list, cur) {
    const entries = (Array.isArray(list) ? list : []).slice(0, DEV_PORTS_MAX)
      .map((x) => readDevEntry(x, { allowLocal: process.env.PAIRBROWSE_TEST_JOIN_LOCAL === "1" })).filter(Boolean);
    const sig = JSON.stringify(entries);
    if (sig === cur.devSig) return;
    const ctx = await context.getContext();
    // The same key for the standby addresses (also): a switch there needs nothing new.
    const cookies = entries.flatMap((e) => [e.origin, ...(e.also || [])].map((url) => ({ name: DEV_COOKIE, value: e.token, url, httpOnly: true, secure: url.startsWith("https:"), sameSite: "Lax" })));
    if (cookies.length) await ctx.addCookies(cookies);
    cur.devSig = sig;
  }

  // The host's tabs as they changed (pushed): applied here.
  async function applyHost(state, cur) {
    if (s !== cur) return;
    await allowDevServers(state.dev, cur).catch((e) => log("shared dev server", e?.message || e));

    const plan = cur.mirror.fromHost(state.tabs, new Set(cur.pages.keys()));
    for (const id of plan.close) { const page = cur.pages.get(id); cur.pages.delete(id); cur.who.delete(id); cur.infos.delete(id); if (page) await closeTab(page); }
    for (const { id, url } of plan.navigate) {
      const page = cur.pages.get(id);
      // Shared browser: the picture shows the host's tab wherever it goes.
      if (!cur.shared) await page?.goto(url, { waitUntil: "commit", timeout: OPEN_MS }).catch((e) => log("shared tab", e?.message || e));
      cur.mirror.applied(id);
    }
    for (const { id, url } of plan.open) {
      if (s !== cur) return;
      const page = await openTab(cur.shared ? screenUrl(id) : url);
      cur.pages.set(id, page);
      cur.seen.add(page);
      cur.mirror.applied(id);
    }

    // Tabs that cross as addresses only (the host's secret domains): nothing else about them.
    cur.quiet = new Set((Array.isArray(state.tabs) ? state.tabs : []).filter((t) => t && t.title === undefined).map((t) => t.id));

    // The same order as there.
    const hostOrder = (Array.isArray(state.tabs) ? state.tabs : []).map((t) => t?.id);
    if (JSON.stringify(hostOrder) !== cur.hostOrderSig) { cur.hostOrderSig = JSON.stringify(hostOrder); cur.order.fromHost(hostOrder); await checkOrder(cur); }

    // Values from there that waited for their page to load here (a shared browser has one copy of each field: theirs).
    if (!cur.shared) await applyForms(cur);
    // Shared browser: each picture's tab title and address, for its page here (and on leaving).
    if (cur.shared) {
      for (const t of Array.isArray(state.tabs) ? state.tabs : []) {
        if (!t?.id) continue;
        const info = { title: String(t.title || "").slice(0, 200), url: String(t.url || "").slice(0, 2048) };
        cur.urls.set(t.id, info.url);
        cur.infos.set(t.id, info);
        showInfo(cur, t.id);
        cur.who.set(t.id, { ...tabWho(t, cur.who.get(t.id)), sig: cur.who.get(t.id)?.sig || "" });
        showWho(cur, t.id);
      }
    }

    // Who is in each tab there: a person using it by hand counts as one here (agents here wait,
    // then hear what they did: names of fields and buttons, never values); the agent holding it
    // shows in the tab overview.
    cur.agents = new Map();
    for (const t of Array.isArray(state.tabs) ? state.tabs : []) {
      const page = cur.pages.get(t.id);
      if (!page || page.isClosed()) continue;
      // An agent there holds this tab: in use, so the tab cap here keeps the copy (closing it would
      // close their tab too).
      // held: it holds the tab's turn there (left ms more, renewed as it acts); agents here wait.
      if (t.agent) {
        const left = turnLeft(t.left);
        cur.agents.set(page, { label: String(t.agent).slice(0, 60), color: /^#[0-9a-f]{6}$/i.test(t.color || "") ? t.color : "", held: left > 0, until: Date.now() + left });
        context.touch?.(page);
      }
      // Their agent's spark, in its color, on the copy here too; else a person using it there, as a
      // dot in their color. A picture page (shared browser) shows both in its own tab (showWho).
      if (!cur.shared) {
        hud.setSharedSpark(page, t.agent ? (/^#[0-9a-f]{6}$/i.test(t.color || "") ? t.color : "#e9763f") : "");
        if (t.person) hud.setPersonMark(page, personColor(t.person));
      }
      const first = !cur.heard.has(t.id);
      const heard = cur.heard.get(t.id) || 0;
      const did = (Array.isArray(t.did) ? t.did : []).filter((e) => Number(e.n) > heard);
      cur.heard.set(t.id, did.length ? Math.max(...did.map((e) => Number(e.n) || 0)) : heard);
      if (first) continue; // on joining, what was done before isn't news
      for (const e of did) presence.elsewhere(page, String(e.who || cur.join.host), [e.line]);
      if (t.person && !did.length) presence.elsewhere(page, String(t.person), [], t.acting === true);
    }

    // What happens there shows here, like local activity.
    const fresh = (Array.isArray(state.activity) ? state.activity : []).filter((a) => a.t > cur.lastT);
    for (const a of cur.lastT ? fresh : fresh.slice(-FIRST_ACTIVITY)) hud.addActivity(a.text, a.who || cur.join.host, cur.pages.get(a.tabId) || null, "joined");
    if (fresh.length) cur.lastT = Math.max(...fresh.map((a) => a.t));
    liveView()?.setRemote((Array.isArray(state.people) ? state.people : []).map((label) => ({ label: `${label} (${cur.join.host}'s session)`, role: cur.join.role })));
  }

  // Shared browser mode: a picture page's title and address (the host tab's), said again only
  // when they changed. Not taken yet (the page still loading, say after a typed address took it
  // away and back): tried again next round.
  function showInfo(cur, id) {
    const info = cur.infos.get(id);
    const page = cur.pages.get(id);
    if (!info || !page || page.isClosed() || !isScreen(page)) return;
    const sig = `${info.title}\u0001${info.url}`;
    if (cur.titles.get(id) === sig) return;
    cur.titles.set(id, sig);
    const unsaid = () => { if (cur.titles.get(id) === sig) cur.titles.delete(id); };
    inScreen(page, (i) => window.pbScreen?.info(i) === true, { ...info, who: cur.join.host }).then((ok) => { if (!ok) unsaid(); }, unsaid);
  }

  // Shared browser mode: who works in one of the host's tabs (a person by hand, an agent holding
  // it), on its picture page's tab here: their name before the title, their mark as its icon.
  // Said again only when it changed; a person who left goes after a few seconds (tabWho).
  function showWho(cur, id) {
    const w = cur.who.get(id);
    const page = cur.pages.get(id);
    if (!w || !page || page.isClosed() || !isScreen(page)) return;
    if (w.person && Date.now() >= w.until) Object.assign(w, { person: "", personColor: "", until: 0 });
    const shown = { person: w.person, personColor: w.personColor, agent: w.agent, agentColor: w.agentColor };
    const sig = JSON.stringify(shown);
    if (w.sig === sig) return;
    w.sig = sig;
    // Not taken yet (the page still loading): tried again next round.
    inScreen(page, (x) => window.pbScreen?.who(x) === true, shown).then((ok) => { if (!ok) w.sig = ""; }, () => { w.sig = ""; });
  }

  // Shared browser mode, each round: a picture page that was sent somewhere else (an address typed
  // in its address bar: that already went to the host as the tab's new address) shows the picture
  // again; the tab in sight gets its direct connection (offer from the host, answer from the
  // page); one that can't connect directly moves to the slower route (pictures and input through
  // the join channel); one out of sight for a while lets its connection go.
  // tell(id, page): passes on a picture page's new address before it shows the picture again (it
  // can arrive after this round read the addresses, and would then never reach the host).
  async function screensRound(cur, tell = () => {}) {
    const now = Date.now();
    for (const [id, page] of cur.pages) {
      if (page.isClosed()) continue;
      if (!isScreen(page)) {
        if (/^https?:/.test(page.url())) { tell(id, page); cur.screens.delete(page); cur.titles.delete(id); if (cur.who.has(id)) cur.who.get(id).sig = ""; await page.goto(screenUrl(id), { waitUntil: "commit", timeout: OPEN_MS }).catch(() => {}); }
        continue;
      }
      const st = await within(800, inScreen(page, () => window.pbScreen?.state() || null).catch(() => null));
      if (!st) continue;
      showInfo(cur, id);
      showWho(cur, id);
      // One record per document: a picture page reloaded (or sent somewhere and back) starts afresh,
      // and the connection asked for the one before it is let go (the slower route, once found, stays).
      let sc = cur.screens.get(page), was = null;
      if (sc && sc.doc !== st.doc) { if (sc.peer) cur.join.screen({ op: "stop", peer: sc.peer }).catch(() => {}); was = sc; sc = null; }
      if (!sc) { sc = { doc: st.doc, peer: null, conn: "none", since: now, tries: was?.tries || 0, fallback: !!was?.fallback, framesOn: !!was?.framesOn, hiddenSince: 0, busy: false }; cur.screens.set(page, sc); }
      if (st.conn !== sc.conn) { sc.conn = st.conn; sc.since = now; }
      sc.hiddenSince = st.visible ? 0 : sc.hiddenSince || now;
      if (st.visible) sc.seenAt = now; // the last one looked at, for this side's agents
      const outOfSight = sc.hiddenSince && now - sc.hiddenSince > SCREEN_KEEP_MS;
      if (sc.fallback) {
        if (outOfSight && sc.framesOn) { sc.framesOn = false; cur.join.screen({ op: "frames", id, on: false }).catch(() => {}); }
        else if (st.visible && !sc.framesOn) { sc.framesOn = true; const r = await cur.join.screen({ op: "frames", id, on: true }); if (r?.error) sc.framesOn = false; }
        continue;
      }
      if (sc.busy) continue;
      if (st.conn === "connected") {
        if (outOfSight) { const peer = sc.peer; sc.peer = null; await inScreen(page, () => window.pbScreen?.close()).catch(() => {}); if (peer) cur.join.screen({ op: "stop", peer }).catch(() => {}); }
        continue;
      }
      const stuck = st.conn === "failed" || (st.conn === "connecting" && now - sc.since > SCREEN_CONNECT_MS) || (st.conn === "disconnected" && now - sc.since > 6000);
      if (stuck) {
        sc.tries++;
        if (sc.peer) cur.join.screen({ op: "stop", peer: sc.peer }).catch(() => {});
        sc.peer = null;
        await inScreen(page, () => window.pbScreen?.close()).catch(() => {});
        if (sc.tries >= 2) { sc.fallback = true; log("shared browser: no direct connection; using the slower route"); startScreenInput(cur); continue; }
      }
      if (st.visible && (st.conn === "none" || stuck)) {
        sc.busy = true;
        sc.since = now;
        (async () => {
          try {
            const r = await cur.join.screen({ op: "want", id });
            if (!r?.sdp) { log("shared browser", r?.error || "no offer"); return; }
            // The page went somewhere else while the host made the offer (an address typed in its
            // bar): its new document asks for its own; this one is let go, never offered to it.
            const stale = () => { cur.join.screen({ op: "stop", peer: r.peer }).catch(() => {}); };
            if (cur.screens.get(page) !== sc || page.isClosed()) return stale();
            sc.peer = r.peer;
            // Tests only (PAIRBROWSE_TEST_NO_DIRECT=1): a network where no direct connection can be made.
            const answer = await inScreen(page, (o) => window.pbScreen?.offer(o) ?? null, { sdp: r.sdp, peer: r.peer, doc: sc.doc, noDirect: process.env.PAIRBROWSE_TEST_NO_DIRECT === "1" });
            if (!answer) { if (sc.peer === r.peer) sc.peer = null; return stale(); }
            const a = await cur.join.screen({ op: "answer", peer: r.peer, sdp: answer });
            if (a?.error) log("shared browser", a.error);
          } catch (e) {
            log("shared browser", e?.message || e);
          } finally {
            sc.busy = false;
          }
        })();
      }
    }
  }
  // The slower route's input: what the person does on a picture page goes to the host every few
  // tens of milliseconds (the direct connection carries it when there is one).
  function startScreenInput(cur) {
    if (cur.inputTimer) return;
    let busy = false;
    cur.inputTimer = setInterval(async () => {
      if (s !== cur) { clearInterval(cur.inputTimer); cur.inputTimer = null; return; }
      if (busy) return;
      busy = true;
      try {
        for (const [id, page] of cur.pages) {
          if (page.isClosed() || !cur.screens.get(page)?.fallback) continue;
          const events = await within(500, inScreen(page, () => window.pbScreen?.takeInput() || []).catch(() => []));
          if (Array.isArray(events) && events.length && cur.join.role === "drive") await cur.join.screen({ op: "input", id, events });
        }
      } finally {
        busy = false;
      }
    }, SCREEN_INPUT_MS);
  }
  // From the host on the join channel: a picture of a tab (the slower route), a connection's state,
  // or a file dialog your click opened there: you pick the files here, they're sent over and go
  // into that field.
  function onScreen(data, cur) {
    if (s !== cur || !data) return;
    if (data.op === "pick" && typeof data.token === "string") {
      const page = cur.pages.get(data.id);
      if (!page || page.isClosed() || cur.join.role !== "drive") return;
      (async () => {
        const picked = await inScreen(page, (o) => window.pbScreen?.pick(o), { multiple: !!data.multiple }).catch(() => null);
        log(`shared browser: ${Array.isArray(picked) ? picked.length : 0} file(s) picked for the host's page`);
        if (!Array.isArray(picked) || !picked.length) return;
        const files = [];
        for (const f of picked.slice(0, 20)) {
          const bytes = Buffer.from(String(f.b64 || ""), "base64");
          const token = randomBytes(8).toString("hex");
          const parts = Math.max(1, Math.ceil(bytes.length / FILE_PART));
          for (let part = 0; part < parts; part++) {
            const r = await cur.join.file({ token, name: String(f.name || "file"), part, data: bytes.subarray(part * FILE_PART, (part + 1) * FILE_PART).toString("base64"), last: part === parts - 1 });
            if (r?.error || r?.problem) { log("shared browser file", r.error || r.problem); return; }
            if (part === parts - 1) files.push(r.path);
          }
        }
        const r = await cur.join.screen({ op: "picked", token: data.token, files });
        log(r?.error ? `shared browser file: ${r.error}` : `shared browser: ${files.length} file(s) put into the host's page`);
      })().catch((e) => log("shared browser file", e?.message || e));
      return;
    }
    if (data.op === "frame" && typeof data.img === "string") {
      const page = cur.pages.get(data.id);
      if (!page || page.isClosed()) return;
      const sc = cur.screens.get(page);
      if (!sc) return;
      // Only the newest picture counts: one waiting replaces the one before.
      sc.nextFrame = data.img;
      if (sc.drawing) return;
      sc.drawing = true;
      (async () => {
        while (sc.nextFrame && s === cur) {
          const img = sc.nextFrame;
          sc.nextFrame = null;
          await inScreen(page, (b) => window.pbScreen?.frame(b), img).catch(() => {});
        }
        sc.drawing = false;
      })();
    }
  }

  // Pointers: this side's (the person's, the agents') go there as they move, up to 25 times a
  // second, with where the person reads (a mark on the other side's scrollbar); theirs come on
  // the stream and are drawn in the copies here. Positions only, never
  // what's under them, and nothing for tabs on secret domains (either side's).
  function sendPointers(cur) {
    if (s !== cur || cur.pointerTimer || cur.shared) return; // shared browser: pointers go with the input
    cur.pointerTimer = setTimeout(async () => {
      cur.pointerTimer = null;
      const fresh = (p) => p && Date.now() - Number(p.t) < POINTER_FRESH_MS;
      let me = null, view = null;
      const agents = [];
      for (const [id, page] of cur.pages) {
        const r = cur.pointed.get(page);
        if (!r || page.isClosed() || cur.quiet.has(id) || onSecretDomain(page.url(), secretDomains()) || !shareableUrl(page.url())) continue;
        if (fresh(r.me) && (!me || r.me.t > me.t)) me = { id, x: r.me.x, y: r.me.y, t: r.me.t };
        // Where the person reads: the tab they scrolled in last.
        if (r.view && Date.now() - Number(r.view.t) < VIEW_FRESH_MS && (!view || r.view.t > view.t)) view = { id, y: r.view.y, h: r.view.h, t: r.view.t };
        const a = localAgent(page);
        if (a && fresh(r.agent)) agents.push({ id, x: r.agent.x, y: r.agent.y, who: a.label, color: a.color });
      }
      const sig = JSON.stringify([me && [me.id, me.x, me.y], agents, view && [view.id, view.y, view.h]]);
      if (sig === cur.pointerSig) return;
      cur.pointerSig = sig;
      await cur.join.pointer({ me: me && { id: me.id, x: me.x, y: me.y }, agents, view: view && { id: view.id, y: view.y, h: view.h }, t: me?.t || Date.now() });
    }, Math.max(0, POINTER_MS - (Date.now() - (cur.pointerAt || 0))));
    cur.pointerAt = Date.now();
  }
  function drawPointers(list, cur) {
    if (s !== cur) return;
    // Shared browser: pointers come as places in the tab's view, drawn over its picture.
    if (cur.shared) {
      const byPage = new Map();
      for (const raw of (Array.isArray(list) ? list : []).slice(0, 24)) {
        const page = cur.pages.get(raw?.id);
        if (!page || page.isClosed() || raw.v || typeof raw.nx !== "number" || typeof raw.ny !== "number") continue;
        byPage.set(page, [...(byPage.get(page) || []), { k: String(raw.k || "").slice(0, 100), who: String(raw.who || "").slice(0, 40), color: raw.color, nx: raw.nx, ny: raw.ny }]);
      }
      for (const page of cur.drawn) if (!byPage.has(page) && !page.isClosed()) inScreen(page, () => window.pbScreen?.pointers([])).catch(() => {});
      cur.drawn = new Set(byPage.keys());
      for (const [page, l] of byPage) inScreen(page, (x) => window.pbScreen?.pointers(x), l).catch(() => {});
      return;
    }
    const ids = new Set([...cur.pages.keys()].filter((id) => !cur.quiet.has(id)));
    const byPage = new Map();
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 24)) {
      const p = raw?.v ? readView(raw, ids) : readPointer(raw, ids);
      const page = p && cur.pages.get(p.id);
      if (!page || page.isClosed() || !p.who || typeof raw.k !== "string") continue;
      if (latencyLog && Number(raw.t) && !p.v) log(`latency pointer ${Date.now() - Number(raw.t)} ms`);
      byPage.set(page, [...(byPage.get(page) || []), { k: raw.k.slice(0, 100), who: p.who, color: p.color || "#e9763f", x: p.x, y: p.y, ...(p.v ? { v: 1, h: p.h } : {}) }]);
    }
    for (const page of cur.drawn) if (!byPage.has(page) && !page.isClosed()) hud.showPointers(page, []);
    cur.drawn = new Set(byPage.keys());
    for (const [page, l] of byPage) hud.showPointers(page, l);
  }

  // Values typed there show in the same fields here (only on the same page).
  async function applyForms(cur, only = null) {
    for (const [id, page] of cur.pages) {
      if ((only && id !== only) || page.isClosed() || cur.quiet.has(id) || onSecretDomain(page.url(), secretDomains())) continue;
      const list = cur.forms.toApply(id, formUrl(page.url()));
      if (!list.length) continue;
      cur.forms.applied(id, await forms.apply(page, list, cur.join.host).catch(() => []));
      if (latencyLog && cur.formT.get(id)) log(`latency form ${Date.now() - cur.formT.get(id)} ms`);
    }
  }
  async function onForm(data, cur) {
    if (s !== cur || !cur.pages.has(data?.id)) return;
    cur.forms.remote(data.id, readForm(data));
    cur.formT.set(data.id, Number(data.t) || 0);
    await applyForms(cur, data.id);
  }

  async function stop(why) {
    const cur = s;
    s = null;
    liveView()?.setRemote([]);
    if (cur) onLeft?.();
    if (cur) for (const page of cur.pages.values()) if (!page.isClosed()) { hud.setSharedSpark(page, ""); hud.setPersonMark(page, ""); }
    if (cur) { clearInterval(cur.inputTimer); cur.inputTimer = null; }
    if (cur) await cur.join.leave();
    // Shared browser: each picture becomes the tab it showed, as your own (signed in as you).
    if (cur?.shared) for (const [id, page] of cur.pages) if (!page.isClosed() && isScreen(page) && /^https?:/.test(cur.urls.get(id) || "")) page.goto(cur.urls.get(id), { waitUntil: "commit", timeout: OPEN_MS }).catch(() => {});
    if (cur && why) log(why);
    return cur;
  }

  // pairbrowse_join. owner: the connection that joined (leaving ends with it). app: its app name.
  async function command(args, { owner, app }) {
    const { action, code, name } = args || {};
    const where = () => `${s.join.message} ${s.pages.size} shared tab(s) open here.`;
    if (action === "status") return { text: s ? where() : "Not in anyone's session." };
    if (action === "leave") {
      const was = await stop();
      return { text: was ? `Left ${was.join.host}'s session. The shared tabs stay open here as your own; they don't follow any more.` : "Not in anyone's session." };
    }
    if (action !== "join") return { text: 'Use "join", "status" or "leave".', error: true };
    let parsed;
    try {
      parsed = parseJoinCode(code, { hosts: Array.isArray(config.joinHosts) ? config.joinHosts.map((h) => String(h).toLowerCase()) : [], allowLocal: process.env.PAIRBROWSE_TEST_JOIN_LOCAL === "1" });
    } catch (e) {
      return { text: `Not joining: ${e.message}`, error: true };
    }
    // Your name, as the host sees it: asked once (the agent asks the user), then remembered.
    if (!cleanName(name, "") && !savedName(config)) return { text: "Not joining yet: ask the user what name the host should see (their first name, say), then call join again with name. It's remembered for next time.", error: true, needsName: true };
    if (cleanName(name, "") && !savedName(config)) { try { saveParticipantName(config, cleanName(name)); } catch {} }
    await stop();
    // The name given at join wins; then the same default the host's side uses.
    const who = cleanName(name, "") || displayName({ configured: config.participantName, env: process.env.PAIRBROWSE_PARTICIPANT, ...currentAccount() }) || cleanName(name);
    const cur = { mirror: createMirror(), pages: new Map(), owner, window: false, windowId: null, lastT: 0, candidates: new Map(), seen: new WeakSet(), heard: new Map(), told: new WeakMap(), agents: new Map(), outbox: [],
      forms: createFormSync(), order: createOrderSync(), quiet: new Set(), agentSent: new Map(), personSent: new Map(), dirty: new Set(), formsAllAt: 0,
      formT: new Map(), pointed: new WeakMap(), pointerTimer: null, pointerSig: "", drawn: new Set(), formTimer: null,
      shared: parsed.mode === "shared", screens: new Map(), titles: new Map(), infos: new Map(), who: new Map(), urls: new Map(), inputTimer: null };
    const queue = serially(); // the host's changes and this side's, one at a time
    cur.queue = queue;
    s = cur;
    cur.join = startJoin({
      join: parsed, name: who, app, log,
      onTabs: (state) => queue(() => applyHost(state, cur)),
      on: {
        form: (data) => queue(() => onForm(data, cur)),
        pointers: (list) => drawPointers(list, cur),
        screen: (data) => onScreen(data, cur),
        agent: (data) => onAgent(data, cur),
        session: (data) => onSession?.(data, cur.join),
        message: (data) => onMessage?.(data, cur.join),
      },
      onChange: (phase) => {
        if (phase === "in") hud.addActivity(`Joined ${parsed.label}'s session (${parsed.role})`, who, null, "joined");
        if ((phase === "denied" || phase === "ended") && s === cur) { s = null; liveView()?.setRemote([]); onLeft?.(); hud.addActivity(cur.join.message, "", null, "joined"); }
      },
    });
    (async () => { while (s === cur) { await sleep(OUTBOUND_MS); if (s === cur) await queue(() => outbound(cur)).catch((e) => log("shared tabs", e?.message || e)); } })();
    if (cur.shared) return {
      text: `Asked ${parsed.label} to let ${who} in (${parsed.role}, shared browser). They have to approve first. Then ${parsed.label}'s tabs open here in a window of their own, each showing their tab live (picture and sound, straight from their browser)` +
        (parsed.role === "drive" ? ", and what you click, type and scroll there happens in their browser itself, logged in as they are." : "; you watch, without clicking or typing there.") +
        " Their logins stay on their computer. Check with pairbrowse_join status; stop with leave (each tab then opens here as your own).",
    };
    return {
      text: `Asked ${parsed.label} to let ${who} in (${parsed.role}). They have to approve first. Then this browser opens ${parsed.label}'s tabs in a window of their own and keeps following them` +
        (parsed.role === "drive" ? "; what you or your agent change in those tabs (another address, a new tab in their window or from one of them, closing one) happens in their browser too." : " (watch: changes here stay here).") +
        " You also see each other's pointers and what's typed in shared tabs (sensitive fields only as filled); logins and cookies are never shared: each of you stays signed in as yourselves. Check with pairbrowse_join status; stop with leave.",
    };
  }

  // Shared browser mode: an agent here works in the host's browser as a participant there. Its
  // calls go over the join channel; files it uploads are sent over first (checked as uploads are
  // here), and the call names them by where they landed there.
  const agentState = new Map(); // participant -> { ready: Promise }
  const pendingCalls = new Map(); // `${agent}|${id}` -> resolve
  let callSeq = 0;
  function onAgent(data, cur) {
    if (s !== cur || typeof data?.line !== "string") return;
    let m;
    try { m = JSON.parse(data.line); } catch { return; }
    if (m?.id === undefined || m.method) return; // their side's notifications: nothing for us
    const k = `${data.a}|${m.id}`;
    const done = pendingCalls.get(k);
    if (done) { pendingCalls.delete(k); done(m); }
  }
  // The host's tab the person here is looking at (its picture page is in sight), or "".
  // In sight now, else the one looked at last.
  const tabInSight = (cur) => {
    let best = "", at = 0;
    for (const [id, page] of cur.pages) {
      const sc = cur.screens.get(page);
      if (!sc) continue;
      if (!sc.hiddenSince) return id;
      if ((sc.seenAt || 0) > at) { at = sc.seenAt; best = id; }
    }
    return best;
  };
  function sendLine(cur, agent, msg, wait = true) {
    if (!wait) return cur.join.agent(agent, JSON.stringify(msg), tabInSight(cur)).then(() => null);
    return new Promise((resolve) => {
      const k = `${agent}|${msg.id}`;
      const timer = setTimeout(() => { pendingCalls.delete(k); resolve({ error: { code: -32000, message: "The host's browser didn't answer in time." } }); }, AGENT_CALL_MS);
      pendingCalls.set(k, (m) => { clearTimeout(timer); resolve(m); });
      cur.join.agent(agent, JSON.stringify(msg)).then((r) => { if (r?.error) { clearTimeout(timer); pendingCalls.delete(k); resolve({ error: { code: -32000, message: `The host's browser refused: ${r.error}` } }); } });
    });
  }
  async function sendFile(cur, path) {
    const problem = uploadProblem(path, paths.uploads);
    if (problem) throw new Error(problem);
    // Size and contents from one open file, so it can't be swapped between the check and the read.
    const fd = openSync(path, "r");
    let data;
    try {
      if (fstatSync(fd).size > 50 * 1024 * 1024) throw new Error(`${path} is too large to send (50 MB at most).`);
      data = readFileSync(fd);
    } finally { closeSync(fd); }
    const token = randomBytes(8).toString("hex");
    const parts = Math.max(1, Math.ceil(data.length / FILE_PART));
    for (let part = 0; part < parts; part++) {
      const r = await cur.join.file({ token, name: path.split(/[\\/]/).pop(), part, data: data.subarray(part * FILE_PART, (part + 1) * FILE_PART).toString("base64"), last: part === parts - 1 });
      if (r?.error || r?.problem) throw new Error(r.error || r.problem);
      if (part === parts - 1) return r.path;
    }
  }
  async function remoteCall(participant, msg, { app }) {
    const cur = s;
    if (!cur?.shared) return { error: { code: -32000, message: "Not in a shared browser session." } };
    const agent = participant.slice(0, 16);
    let st = agentState.get(participant);
    if (!st || st.cur !== cur) {
      st = { cur, ready: sendLine(cur, agent, { jsonrpc: "2.0", id: `init-${++callSeq}`, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: app || "agent", version: "1" } } })
        .then(() => sendLine(cur, agent, { jsonrpc: "2.0", method: "notifications/initialized" }, false)) };
      agentState.set(participant, st);
    }
    await st.ready;
    const name = msg.params?.name;
    let args = msg.params?.arguments || {};
    const paths = pathsIn(name, args);
    if (paths.length) {
      const map = new Map();
      try { for (const p of paths) map.set(p, await sendFile(cur, p)); } catch (e) { return { result: { content: [{ type: "text", text: String(e?.message || e) }], isError: true } }; }
      args = withPaths(name, args, map);
    }
    const out = await sendLine(cur, agent, { jsonrpc: "2.0", id: `c-${++callSeq}`, method: "tools/call", params: { ...msg.params, arguments: args } });
    const { id: _id, ...rest } = out || {};
    return rest.result || rest.error ? rest : { error: { code: -32000, message: "No answer from the host's browser." } };
  }

  return {
    command,
    // Shared browser mode: whether a tool call from an agent here goes to the host's browser, and
    // making that call (see remoteCall).
    forwards: (name) => !!s?.shared && s.join.phase === "in" && s.join.role === "drive" && (String(name).startsWith("browser_") || FORWARDED.has(name)),
    remoteCall,
    // The connection that joined went away: so does the join.
    ownerGone(owner) { if (s?.owner === owner) stop("left the shared session: its connection closed").catch(() => {}); },
    stop,
    // The agent holding this shared tab in the other browser ({ label, color, held, until }), for
    // the tab overview and turns (an agent here waits while it's held).
    agentIn: (page) => s?.agents.get(page) || null,
    // The shared copies here (the page script is read in them, daemon/cobrowse.mjs).
    pages: () => (s ? [...s.pages.values()] : []),
    // The host tab this side's new agents start on (in sight, else looked at last), by its id.
    inSight: () => (s ? tabInSight(s) : ""),
    // A field changed in a shared copy: its values go there within a few tens of ms.
    dirty(page) {
      const cur = s;
      if (!cur || ![...cur.pages.values()].includes(page)) return;
      cur.dirty.add(page);
      if (!cur.formTimer) cur.formTimer = setTimeout(() => { cur.formTimer = null; cur.queue(() => outbound(cur)).catch(() => {}); }, FORM_COALESCE_MS);
    },
    // The person or agent here pointed somewhere in a shared copy.
    pointed(page, value) { const cur = s; if (cur && [...cur.pages.values()].includes(page)) { cur.pointed.set(page, value); sendPointers(cur); } },
    // A message or session update for the host (both roles: it's only text).
    say: (op) => s?.join.say?.(op),
    joined: () => s?.join.phase === "in",
    // The name of the host whose session was joined from here, or "".
    host: () => s?.join.host || "",
    // "drive" or "watch" while in a session joined from here, else null.
    role: () => (s?.join.phase === "in" ? s.join.role : null),
  };
}
