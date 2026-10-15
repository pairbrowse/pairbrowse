// Follow mode, on the joiner's side: the host's tabs open here as real tabs of this browser and
// follow theirs; with a drive code, changes here go there. Addresses, form values (sensitive ones
// only as filled), tab order, pointers and who does what cross (tabsync.mjs). In shared browser
// mode the same rounds carry the picture pages' addresses (api: join/screens.mjs).
// live: the session joined now (join/state.mjs newFollowState).
import { sentAgo } from "../presence.mjs";
import { readForm, readPointer, readView, ownPointer, formUrl, VIEW_FRESH_MS, onSecretDomain, shareableUrl, crossingText, turnLeft, tabWho, personColor, sameOrder, TABS_MAX, OPS_MAX } from "../../sharing/tabsync.mjs";
import { keepFocus } from "../../focus.mjs";
import { readDevEntry, DEV_COOKIE, DEV_PORTS_MAX } from "../../sharing/devshare.mjs";
import { sleep } from "../../util.mjs";
import { AGENT_COLOR, isColor } from "../../../ui/vocab.js";
import { JOINER_POINTER_EVERY_MS } from "../../../ui/limits.js";
import { inScreen } from "./screens.mjs";
import { OPEN_MS } from "./state.mjs";
import { testOn } from "../../testenv.mjs";

const ADOPT_MS = 10_000; // a tab opened from a shared one has this long to get a web address (in the shared window: no limit)
const FIRST_ACTIVITY = 3; // on joining, the last few things that happened
const FORM_BYTES = 60_000; // form values read here in one round, before it's sent
const AGENT_AGAIN_MS = 10_000; // an agent here is said again this often (the other side forgets it)
const POINTER_FRESH_MS = 3000; // a pointer still for this long fades out
const POINTER_MS = JOINER_POINTER_EVERY_MS; // pointers go out at most 25 times a second
const PERSON_AGAIN_MS = 500;
const LATE_NEWS_MS = 15_000; // what a person here did, still sent when a round comes this late
const FORMS_ALL_MS = 2000; // every field is read again this often, in case a change went unannounced
const ORDER_MS = 1000; // the tab order here is checked this often
// Logs how long pointers and field values took from the other side's page (for the live check).
const latencyLog = process.env.PAIRBROWSE_LATENCY_LOG === "1";

// A person in the host's browser, from one tab of its state (applyHost): what they did there that
// is new here (did, each with its own ago: stateAgo), else whether they act there now (the tab's
// ago). Every ago counts back from heardAt, when the state arrived here, not from now: it may
// have waited behind other changes before it's applied. A host without the times sends no ago:
// from arrival, as before.
export function hostPeople(presence, page, t, did, host, heardAt = Date.now()) {
  const ago = (x) => (Number.isFinite(x?.ago) ? x.ago : 0);
  for (const e of did) presence.elsewhere(page, String(e.who || host), [e.line], false, ago(e), heardAt);
  // The same moment however often the state comes again while they keep still.
  if (t.person && !did.length) presence.elsewhere(page, String(t.person), [], t.acting === true, t.acting === true ? ago(t) : 0, heardAt);
}

export function createJoinMirror(live, { context, log, hud, presence, liveView, secretDomains, forms, tabOrder, localAgent }, api) {
  const idOf = (cur, page) => { for (const [id, p] of cur.pages) if (p === page) return id; return null; };

  // This browser's agents' activity in a shared tab goes to the other browser (drive), like its
  // address changes. What came from there is marked and never goes back.
  hud.onActivity((text, who, page, from) => {
    const cur = live.cur;
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

  // The shared window in front once this browser's own saved tabs are back (joining from the
  // session picker or by an agent reopens them, in the other window): they must not cover the
  // session the person just joined. On macOS the browser itself isn't pulled over the app in use.
  function frontOnceRestored(page) {
    (async () => {
      for (let i = 0; i < 300 && context.isRestoring?.(); i++) await sleep(100);
      await sleep(300);
      if (!page.isClosed()) await keepFocus(() => page.bringToFront()).catch(() => {});
    })().catch(() => {});
  }

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
      try { ({ targetId } = await cdp.send("Target.createTarget", { url, newWindow: !live.cur.window, background: !!live.cur.window })); } finally { cdp.detach().catch(() => {}); }
      const until = Date.now() + OPEN_MS;
      while (Date.now() < until) {
        for (const p of ctx.pages()) {
          if (before.has(p) || p.isClosed() || (await pageId(ctx, p).catch(() => "")) !== targetId) continue;
          if (!live.cur.window) {
            live.cur.windowId = await windowOf(ctx, p).catch(() => null); // the shared window
            frontOnceRestored(p);
          }
          live.cur.window = true;
          return p;
        }
        await sleep(100);
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
    if (live.cur !== cur || cur.join.phase !== "in") return;
    const drive = cur.join.role === "drive";
    const ctx = await context.getContext();
    const mine = { full: drive, secretDomains: secretDomains() };
    const ops = [];
    for (const [id, page] of cur.pages) {
      if (page.isClosed()) { forgetTab(cur, id, page); const op = cur.mirror.closedHere(id); if (drive && op) ops.push(op); continue; }
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
          // at: when they last clicked or typed here, sent as an ago measured as it leaves (sentAgo):
          // news that crosses late holds nobody longer.
          const at = (person?.acting ? person.at : fresh.length ? fresh.at(-1).t : null) ?? Date.now();
          ops.push({ op: "person", id, did: fresh.map((e) => e.line), ...(person?.acting ? { acting: true } : {}), at });
        }
      }
    }
    // Values typed here (sensitive ones only as filled), read at most every few hundred ms per
    // tab; and the agents here (drive). A watcher's stay here; reading them still keeps values
    // from there from landing on top of what the person here is typing.
    if (cur.shared) await api.screensRound(cur, (id, page) => {
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
      for (const p of cur.candidates.keys()) if (p.isClosed()) cur.candidates.delete(p); // closed before it was adopted
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
        const batch = ops.slice(i, i + OPS_MAX).map((o) => sentAgo(o));
        const r = await cur.join.send(batch);
        if (r) answer = { ...r, opened: { ...answer?.opened, ...r.opened } };
      }
      for (const { op, page } of adopting) {
        const id = answer?.opened?.[op.ref];
        if (!id || !cur.mirror.opened(id, op.url)) continue;
        cur.pages.set(id, page);
        // Shared browser: the tab opened there; here it becomes its picture.
        if (cur.shared) await page.goto(api.screenUrl(id), { waitUntil: "commit", timeout: OPEN_MS }).catch(() => {});
      }
    }
  }

  // A move made here goes there (drive); else the host's order applies here.
  async function checkOrder(cur) {
    cur.orderAt = Date.now();
    const open = [...cur.pages].filter(([, p]) => !p.isClosed());
    if (open.length < 2) return;
    const sorted = await tabOrder.order(open.map(([, p]) => p)).catch(() => null);
    if (!sorted || live.cur !== cur) return;
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
      .map((x) => readDevEntry(x, { allowLocal: testOn("JOIN_LOCAL") })).filter(Boolean);
    const sig = JSON.stringify(entries);
    if (sig === cur.devSig) return;
    const ctx = await context.getContext();
    // The same key for the standby addresses (also): a switch there needs nothing new.
    const cookies = entries.flatMap((e) => [e.origin, ...(e.also || [])].map((url) => ({ name: DEV_COOKIE, value: e.token, url, httpOnly: true, secure: url.startsWith("https:"), sameSite: "Lax" })));
    if (cookies.length) await ctx.addCookies(cookies);
    cur.devSig = sig;
  }

  // A shared tab closed (there or here): everything kept about it goes, so a long session doesn't
  // collect the state of every tab it ever saw.
  function forgetTab(cur, id, page) {
    for (const m of [cur.pages, cur.who, cur.infos, cur.urls, cur.heard, cur.titles, cur.agentSent, cur.personSent, cur.formT]) m.delete(id);
    cur.forms.drop(id);
    if (page) { cur.screens.delete(page); cur.dirty.delete(page); }
  }

  // The host's tabs as they changed (pushed): applied here. heardAt: when they arrived (a person
  // acting there counts back from then: they may wait here in line behind other changes).
  async function applyHost(state, cur, heardAt = Date.now()) {
    if (live.cur !== cur) return;
    await allowDevServers(state.dev, cur).catch((e) => log("shared dev server", e?.message || e));

    const plan = cur.mirror.fromHost(state.tabs, new Set(cur.pages.keys()));
    for (const id of plan.close) { const page = cur.pages.get(id); forgetTab(cur, id, page); if (page) await closeTab(page); }
    for (const { id, url } of plan.navigate) {
      const page = cur.pages.get(id);
      // Shared browser: the picture shows the host's tab wherever it goes.
      if (!cur.shared) await page?.goto(url, { waitUntil: "commit", timeout: OPEN_MS }).catch((e) => log("shared tab", e?.message || e));
      cur.mirror.applied(id);
    }
    for (const { id, url } of plan.open) {
      if (live.cur !== cur) return;
      const page = await openTab(cur.shared ? api.screenUrl(id) : url);
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
        api.showInfo(cur, t.id);
        cur.who.set(t.id, { ...tabWho(t, cur.who.get(t.id)), sig: cur.who.get(t.id)?.sig || "" });
        api.showWho(cur, t.id);
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
        hud.setSharedSpark(page, t.agent ? (isColor(t.color) ? t.color : AGENT_COLOR) : "");
        if (t.person) hud.setPersonMark(page, personColor(t.person));
      }
      const first = !cur.heard.has(t.id);
      const heard = cur.heard.get(t.id) || 0;
      const did = (Array.isArray(t.did) ? t.did : []).filter((e) => Number(e.n) > heard);
      cur.heard.set(t.id, did.length ? Math.max(...did.map((e) => Number(e.n) || 0)) : heard);
      if (first) continue; // on joining, what was done before isn't news
      hostPeople(presence, page, t, did, cur.join.host, heardAt);
    }

    // What happens there shows here, like local activity.
    const fresh = (Array.isArray(state.activity) ? state.activity : []).filter((a) => a.t > cur.lastT);
    for (const a of cur.lastT ? fresh : fresh.slice(-FIRST_ACTIVITY)) hud.addActivity(a.text, a.who || cur.join.host, cur.pages.get(a.tabId) || null, "joined");
    if (fresh.length) cur.lastT = Math.max(...fresh.map((a) => a.t));
    liveView()?.setRemote((Array.isArray(state.people) ? state.people : []).map((label) => ({ label: `${label} (${cur.join.host}'s session)`, role: cur.join.role })));
  }

  // Pointers: this side's (the person's, the agents') go there as they move, up to 25 times a
  // second, with where the person reads (a mark on the other side's scrollbar); theirs come on
  // the stream and are drawn in the copies here. Positions only, never
  // what's under them, and nothing for tabs on secret domains (either side's).
  function sendPointers(cur) {
    if (live.cur !== cur || cur.pointerTimer || cur.shared) return; // shared browser: pointers go with the input
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
    if (live.cur !== cur) return;
    // Shared browser: pointers come as places in the tab's view, drawn over its picture.
    if (cur.shared) {
      const byPage = new Map();
      for (const raw of (Array.isArray(list) ? list : []).slice(0, 24)) {
        const page = cur.pages.get(raw?.id);
        if (!page || page.isClosed() || raw.v || ownPointer(raw.k, cur.joinerId) || typeof raw.nx !== "number" || typeof raw.ny !== "number") continue;
        byPage.set(page, [...(byPage.get(page) || []), { k: String(raw.k || "").slice(0, 100), who: String(raw.who || "").slice(0, 40), color: raw.color, nx: raw.nx, ny: raw.ny }]);
      }
      for (const page of cur.drawn) if (!byPage.has(page) && !page.isClosed()) inScreen(page, () => window.pbScreen?.pointers([])).catch(() => {});
      cur.drawn = new Set(byPage.keys());
      // The page is told who it is for too: it never draws that person's own pointer either.
      for (const [page, l] of byPage) inScreen(page, ([x, self]) => window.pbScreen?.pointers(x, self), [l, cur.joinerId]).catch(() => {});
      return;
    }
    const ids = new Set([...cur.pages.keys()].filter((id) => !cur.quiet.has(id)));
    const byPage = new Map();
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 24)) {
      const p = raw?.v ? readView(raw, ids) : readPointer(raw, ids);
      const page = p && cur.pages.get(p.id);
      // Never this person's own pointer (or their agents'), whatever the host sends.
      if (!page || page.isClosed() || !p.who || typeof raw.k !== "string" || ownPointer(raw.k, cur.joinerId)) continue;
      if (latencyLog && Number(raw.t) && !p.v) log(`latency pointer ${Date.now() - Number(raw.t)} ms`);
      byPage.set(page, [...(byPage.get(page) || []), { k: raw.k.slice(0, 100), who: p.who, color: p.color || AGENT_COLOR, x: p.x, y: p.y, ...(p.v ? { v: 1, h: p.h } : {}) }]);
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
    if (live.cur !== cur || !cur.pages.has(data?.id)) return;
    cur.forms.remote(data.id, readForm(data));
    cur.formT.set(data.id, Number(data.t) || 0);
    await applyForms(cur, data.id);
  }

  return { idOf, outbound, checkOrder, applyHost, forgetTab, sendPointers, drawPointers, applyForms, onForm };
}
